import PostalMime from "postal-mime"
import { discoverMessages } from "./mailbox-sync.mjs"
import { createOutbox, OUTBOX_PREFIX } from "./outbox.mjs"

const PUSH_ENDPOINT = "https://push.scripting.fun/push"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
const GRAPH_API = "https://graph.microsoft.com/v1.0/me"
const CONFIG_KEY = "mail-push:owner-config:v2"
const PUSH_KEY_KEY = "mail-push:owner-push-key:v1"
const MICROSOFT_WEBHOOK_PATH = "/v1/webhooks/microsoft/mail"
const MICROSOFT_SUBSCRIPTION_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000
const MICROSOFT_RENEW_WINDOW_MS = 12 * 60 * 60 * 1000
const OUTBOX_TTL_SECONDS = 7 * 24 * 60 * 60
const MAX_MESSAGES_PER_CHECK = 50
const MAX_LIST_PAGES = 100
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64(bytes) {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function base64ToBytes(value) {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function encryptionKey(env) {
  let raw
  if (env.MAIL_PUSH_ENCRYPTION_KEY) {
    raw = base64ToBytes(env.MAIL_PUSH_ENCRYPTION_KEY)
    if (raw.length !== 32) throw new Error("MAIL_PUSH_ENCRYPTION_KEY must contain 32 bytes")
  } else {
    throw new Error("MAIL_PUSH_ENCRYPTION_KEY is missing")
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])
}

async function seal(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), encoder.encode(JSON.stringify(value)))
  return JSON.stringify({ version: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) })
}

async function open(value, env) {
  const envelope = JSON.parse(value)
  if (envelope?.version !== 1) throw new Error("Unsupported encrypted record")
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv) }, await encryptionKey(env), base64ToBytes(envelope.ciphertext))
  return JSON.parse(decoder.decode(decrypted))
}

function authorized(request, env) {
  const token = env.MAIL_PUSH_ADMIN_TOKEN
  return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`
}

async function jsonBody(request, maxBytes) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) throw new Error("UNSUPPORTED_MEDIA_TYPE")
  try {
    if (!maxBytes) return await request.json()
    const bytes = await request.arrayBuffer()
    if (bytes.byteLength > maxBytes) throw new Error("PAYLOAD_TOO_LARGE")
    return JSON.parse(decoder.decode(bytes))
  } catch (error) {
    if (error?.message === "PAYLOAD_TOO_LARGE") throw error
    throw new Error("INVALID_JSON")
  }
}

function accountFromInput(value) {
  const provider = String(value?.provider ?? "")
  if (provider !== "gmail" && provider !== "microsoft") throw new Error("UNSUPPORTED_PROVIDER")
  const id = String(value?.id ?? "")
  const address = String(value?.address ?? "").trim().toLowerCase()
  const refreshToken = String(value?.refreshToken ?? "").trim()
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id) || !/^\S+@\S+\.\S+$/.test(address) || !refreshToken) throw new Error("INVALID_ACCOUNT")
  return { id, provider, address, refreshToken, newestId: typeof value?.newestId === "string" ? value.newestId : "" }
}

const tokenCache = new Map()
async function refreshGoogle(account, env) {
  const cached = tokenCache.get(`gmail:${account.id}`)
  if (cached && cached.refreshToken === account.refreshToken && cached.until > Date.now()+60000) return cached
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("Google OAuth configuration is incomplete")
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET })
  const response = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body })
  const payload = await response.json()
  if (!response.ok || !payload?.access_token) throw new Error("GMAIL_REFRESH_FAILED")
  const renewed = { accessToken: String(payload.access_token), refreshToken: String(payload.refresh_token || account.refreshToken), until: Date.now()+Math.max(0,Number(payload.expires_in || 0))*1000 }
  tokenCache.set(`gmail:${account.id}`,renewed)
  return renewed
}

async function refreshMicrosoft(account, env) {
  const cached = tokenCache.get(`microsoft:${account.id}`)
  if (cached && cached.refreshToken === account.refreshToken && cached.until > Date.now()+60000) return cached
  if (!env.MICROSOFT_CLIENT_ID) throw new Error("Microsoft OAuth configuration is incomplete")
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: env.MICROSOFT_CLIENT_ID, scope: "openid profile email offline_access User.Read Mail.ReadWrite" })
  if (env.MICROSOFT_CLIENT_SECRET) body.set("client_secret", env.MICROSOFT_CLIENT_SECRET)
  const response = await fetch(MICROSOFT_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body })
  const payload = await response.json()
  if (!response.ok || !payload?.access_token) throw new Error("MICROSOFT_REFRESH_FAILED")
  const renewed = { accessToken: String(payload.access_token), refreshToken: String(payload.refresh_token || account.refreshToken), until: Date.now()+Math.max(0,Number(payload.expires_in || 0))*1000 }
  tokenCache.set(`microsoft:${account.id}`,renewed)
  return renewed
}

function gmailHeader(message, name) {
  return String(message?.payload?.headers?.find(item => String(item?.name).toLowerCase() === name)?.value ?? "")
}

async function gmailMessages(account, env) {
  const renewed = await refreshGoogle(account, env)
  account.refreshToken = renewed.refreshToken
  const headers = { Authorization: `Bearer ${renewed.accessToken}`, Accept: "application/json" }
  const ids = []
  let pageToken = ""
  let boundary = -1
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ labelIds: "INBOX", maxResults: "100" })
    if (pageToken) query.set("pageToken", pageToken)
    const listResponse = await fetch(`${GMAIL_API}/messages?${query}`, { headers })
    const list = await listResponse.json()
    if (!listResponse.ok) throw new Error("GMAIL_LIST_FAILED")
    for (const item of list.messages ?? []) {
      const id = String(item?.id ?? "")
      if (!id) continue
      ids.push(id)
      if (account.newestId && id === account.newestId) { boundary = ids.length - 1; break }
    }
    if (!account.newestId || boundary >= 0 || !list.nextPageToken) break
    pageToken = String(list.nextPageToken)
  }
  if (!ids.length) return { messages: [], newestId: account.newestId }
  if (!account.newestId) return { messages: [], newestId: ids[0] }
  if (boundary < 0) throw new Error("GMAIL_CURSOR_GAP_REQUIRES_RESYNC")
  const newIds = ids.slice(0, boundary)
  const batchIds = newIds.slice(-MAX_MESSAGES_PER_CHECK).reverse()
  const messages = []
  for (const id of batchIds) {
    const response = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`, { headers })
    const value = await response.json()
    if (!response.ok) throw new Error("GMAIL_MESSAGE_FAILED")
    messages.push({ id, from: gmailHeader(value, "from"), subject: gmailHeader(value, "subject"), preview: String(value.snippet ?? ""), messageId: gmailHeader(value, "message-id") })
  }
  return { messages, newestId: messages.length ? messages[messages.length - 1].id : account.newestId }
}

async function ensureMicrosoftSubscription(account, env, force = false) {
  const expiresAt = Date.parse(account.microsoftSubscriptionExpiresAt || "")
  if (!force && account.microsoftSubscriptionId && expiresAt - Date.now() > MICROSOFT_RENEW_WINDOW_MS) return false
  const renewed = await refreshMicrosoft(account, env)
  account.refreshToken = renewed.refreshToken
  const expirationDateTime = new Date(Date.now() + MICROSOFT_SUBSCRIPTION_LIFETIME_MS).toISOString()
  const headers = { Authorization: `Bearer ${renewed.accessToken}`, "Content-Type": "application/json", Accept: "application/json" }
  let response
  if (account.microsoftSubscriptionId) {
    response = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(account.microsoftSubscriptionId)}`, {
      method: "PATCH", headers, body: JSON.stringify({ expirationDateTime }),
    })
    if (response.status === 404) account.microsoftSubscriptionId = ""
  }
  if (!account.microsoftSubscriptionId) {
    if (!account.microsoftClientState) account.microsoftClientState = bytesToBase64(crypto.getRandomValues(new Uint8Array(24)))
    response = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
      method: "POST", headers,
      body: JSON.stringify({
        changeType: "created",
        notificationUrl: `${new URL(env.PUBLIC_ORIGIN).origin}${MICROSOFT_WEBHOOK_PATH}`,
        resource: "me/mailFolders('inbox')/messages",
        expirationDateTime,
        clientState: account.microsoftClientState,
      }),
    })
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`MICROSOFT_SUBSCRIPTION_FAILED_${response.status}`)
  account.microsoftSubscriptionId = String(payload.id || account.microsoftSubscriptionId)
  account.microsoftSubscriptionExpiresAt = String(payload.expirationDateTime || expirationDateTime)
  return true
}

async function deleteMicrosoftSubscription(account, env) {
  if (!account?.microsoftSubscriptionId) return
  try {
    const renewed = await refreshMicrosoft(account, env)
    const response = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(account.microsoftSubscriptionId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${renewed.accessToken}`, Accept: "application/json" },
    })
    if (!response.ok && response.status !== 404) throw new Error(`HTTP_${response.status}`)
  } catch (error) {
    console.warn("Microsoft subscription cleanup failed", String(error?.message ?? error).replace(/[^A-Z0-9_ -]/gi, ""))
  }
}

async function microsoftMessages(account, env) {
  const renewed = await refreshMicrosoft(account, env)
  account.refreshToken = renewed.refreshToken
  const values = []
  let nextURL = ""
  let boundary = -1
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ "$top": "100", "$orderby": "receivedDateTime desc", "$select": "id,subject,from,bodyPreview,internetMessageId" })
    const response = await fetch(nextURL || `${GRAPH_API}/mailFolders/inbox/messages?${query}`, { headers: { Authorization: `Bearer ${renewed.accessToken}`, Accept: "application/json" } })
    const payload = await response.json()
    if (!response.ok) throw new Error("MICROSOFT_LIST_FAILED")
    for (const item of Array.isArray(payload.value) ? payload.value : []) {
      values.push(item)
      if (account.newestId && String(item?.id ?? "") === account.newestId) { boundary = values.length - 1; break }
    }
    if (!account.newestId || boundary >= 0 || !payload["@odata.nextLink"]) break
    nextURL = String(payload["@odata.nextLink"])
    if (new URL(nextURL).origin !== "https://graph.microsoft.com") throw new Error("MICROSOFT_INVALID_NEXT_LINK")
  }
  if (!values.length) return { messages: [], newestId: account.newestId }
  if (!account.newestId) return { messages: [], newestId: String(values[0]?.id ?? account.newestId) }
  if (boundary < 0) throw new Error("MICROSOFT_CURSOR_GAP_REQUIRES_RESYNC")
  const incoming = values.slice(0, boundary)
  const batch = incoming.slice(-MAX_MESSAGES_PER_CHECK).reverse()
  const messages = batch.map(item => ({ id: String(item.id), from: String(item?.from?.emailAddress?.name || item?.from?.emailAddress?.address || ""), subject: String(item?.subject ?? ""), preview: String(item?.bodyPreview ?? ""), messageId: String(item?.internetMessageId ?? "") }))
  return { messages, newestId: messages.length ? messages[messages.length - 1].id : account.newestId }
}

function clipped(value, maximum) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim()
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized
}

async function activePushKey(record, env) {
  const encrypted = await env.MAIL_PUSH_STORE.get(PUSH_KEY_KEY)
  if (!encrypted) return record.pushKey
  return (await open(encrypted, env)).pushKey
}

async function sendPush(pushKey, message) {
  const sender = clipped(message.from, 80) || "新邮件"
  const subject = clipped(message.subject, 120) || "无主题"
  const preview = clipped(message.preview, 160)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  let response, payload = null
  try {
    response = await fetch(PUSH_ENDPOINT, {
      signal: controller.signal,
      method: "POST",
      headers: { Authorization: `Bearer ${pushKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ title: sender, body: preview ? `${subject}\n${preview}` : subject, threadId: "cloud-mail-manager", action: message.action || "scripting://run/云邮管家", icon: message.icon || "https://red-sea-7bc7.1085481057.workers.dev/icons/cloudmail.png", iconColor: "#0A84FF", sound: "default", interruptionLevel: "active" }),
    })
    try { payload = await response.json() } catch {}
  } finally { clearTimeout(timer) }
  if (!response.ok || payload?.ok === false) {
    const code = String(payload?.error?.code ?? payload?.code ?? `HTTP_${response.status}`)
    const error = new Error(`REMOTE_PUSH_FAILED_${code}`)
    const retry = response.headers.get("Retry-After") || ""
    error.retryAfterMs = Math.min(86400000, Math.max(0, /^\d+$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now()) || 0)
    throw error
  }
  const targets = Number(payload?.data?.target_devices)
  if (!Number.isFinite(targets) || targets < 1) throw new Error("REMOTE_PUSH_NO_TARGET_DEVICE")
  return { targets }
}

function forwardedProvider(address) {
  const local = String(address ?? "").toLowerCase().split("@")[0]
  if (local === "gmail-push") return "gmail"
  if (/^qq-push(?:-v\d+)?$/.test(local)) return "qq"
  if (local === "netease-push") return "netease"
  return "forwarded"
}

function decodeBase64Text(value) {
  return decoder.decode(base64ToBytes(String(value).replace(/\s+/g, "")))
}

function htmlToText(value) {
  return String(value ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

async function parsedBody(parsed, depth = 0) {
  const text = String(parsed?.text ?? "").trim()
  const html = String(parsed?.html ?? "").trim()
  const content = { text, html, from: parsedSender(parsed, ""), subject: String(parsed?.subject ?? "").trim() }
  if (text || html || depth >= 2) return content
  for (const attachment of parsed?.attachments ?? []) {
    const mimeType = String(attachment?.mimeType ?? "").toLowerCase()
    const filename = String(attachment?.filename ?? "")
    const nestedMail = mimeType === "message/rfc822" || mimeType === "message/global" || /\.eml$/i.test(filename)
    const content = attachment?.content
    if (!nestedMail || !content || Number(content.byteLength ?? content.length ?? 0) > 2_000_000) continue
    try {
      const nested = await parsedBody(await PostalMime.parse(content), depth + 1)
      if (nested.text || nested.html) return nested
    } catch {}
  }
  return content
}

const VERIFICATION_KEYWORD_REGEX = /(?:验证码|校验码|动态码|登录码|安全码|确认码|一次性密码|verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP|code\s+to\s+(?:log\s*in|sign\s*in)|(?:enter|use)\s+(?:the\s+)?(?:following\s+)?code)/i

function isVerificationCodeCandidate(code, text) {
  if (!code || !/\d/.test(code)) return false
  if (code.length < 4 || code.length > 8) return false
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g")
  let match
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index
    const end = start + code.length
    const before = text.slice(Math.max(0, start - 25), start).trimEnd()
    const after = text.slice(end, end + 25).trimStart()
    if (/^(?:[,，]\s*(?:您好|你好|hello|hi|先生|女士)|(?:\s*(?:您好|你好))|@)/i.test(after)) continue
    if (/(?:尊敬的|亲爱的|Dear|Hi|Hello|用户)\s*$/i.test(before)) continue
    if (/^(?:分钟|秒|小时|天|minutes?|mins?|seconds?|secs?|hours?)/i.test(after)) continue
    if (/^\s*[-/:]\d/.test(after) || /\d[-/:]\s*$/.test(before)) continue
    return true
  }
  return false
}

function forwardedVerificationCode(subject, body) {
  const combined = `${subject}\n${body}`
  if (!VERIFICATION_KEYWORD_REGEX.test(combined)) return ""

  const highConfidencePatterns = [
    /(?:验证码|校验码|动态码|登录码|安全码|确认码|一次性密码)\s*(?:为|是|为[:：]?|是[:：]?|[:：])\s*['"“‘【\[(]?([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/gi,
    /(?:verification|security|login|confirmation|one[- ]time)\s*(?:code|passcode|password|OTP)\s*(?:is\s*[:：]?|[:：])\s*['"“‘【\[(]?([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/gi,
    /(?:code\s+to\s+(?:log\s*in|sign\s*in)|(?:enter|use)\s+(?:the\s+)?(?:following\s+)?code)\s*[:：]?\s*['"“‘【\[(]?([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/gi,
    /(?<![A-Za-z0-9])([A-Za-z0-9]{4,8})\s*(?:(?:为|是)?(?:您的)?(?:邮箱|短信|登录|动态|安全)?(?:验证码|校验码|动态码|安全码|确认码|一次性密码)|is your (?:verification|security|login|one-time) code)/gi,
    /【([A-Za-z0-9]{4,8})】\s*(?:(?:为|是)?(?:您的)?(?:验证码|校验码|动态码|登录码|安全码|确认码)|[^\n]{0,10}(?:验证码|校验码|动态码|登录码|安全码|确认码))/gi,
    /(?:验证码|校验码|动态码|登录码|安全码|确认码)[^\n]{0,10}【([A-Za-z0-9]{4,8})】/gi,
  ]

  for (const pattern of highConfidencePatterns) {
    for (const text of [body, subject]) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        const candidate = match[1]
        if (isVerificationCodeCandidate(candidate, text)) return candidate
      }
    }
  }

  const mediumConfidencePatterns = [
    /(?:验证码|校验码|动态码|登录码|安全码|确认码|一次性密码|verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP)[^A-Za-z0-9\n]{0,15}(?:\r?\n\s*)?['"“‘【\[(]?([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/gi,
  ]

  for (const pattern of mediumConfidencePatterns) {
    for (const text of [body, subject]) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        const candidate = match[1]
        if (isVerificationCodeCandidate(candidate, text)) return candidate
      }
    }
  }

  return ""
}

function parsedSender(parsed, fallback) {
  const name = String(parsed?.from?.name ?? "").trim()
  const address = String(parsed?.from?.address ?? "").trim()
  return name && address ? `${name} <${address}>` : name || address || fallback
}

function qqVerificationLink(raw, recipient) {
  const unfoldedRaw = raw.replace(/=\r?\n/g, "")
  const sources = [unfoldedRaw]
  const htmlParts = unfoldedRaw.matchAll(/Content-Type:\s*text\/html;[\s\S]*?Content-Transfer-Encoding:\s*base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+?)(?=\r?\n--[-=_A-Za-z0-9]+)/gi)
  for (const part of htmlParts) {
    try { sources.push(decodeBase64Text(part[1])) } catch {}
  }
  const candidates = sources.flatMap(source => [
    ...[...source.matchAll(/href=["']([^"']+)["']/gi)].map(match => match[1]),
    ...[...source.matchAll(/https:\/\/[^\s<>"']{10,1000}/gi)].map(match => match[0]),
  ])
  return candidates.map(candidate => candidate.replace(/&amp;/gi, "&")).find(candidate => {
    try {
      const target = new URL(candidate)
      return target.protocol === "https:"
        && target.hostname === "wx.mail.qq.com"
        && target.pathname === "/setting/filter"
        && target.searchParams.get("handler") === "verifyfw_result"
        && target.searchParams.get("email")?.toLowerCase() === String(recipient).toLowerCase()
    } catch {
      return false
    }
  })
}

async function messageFingerprint(provider, message) {
  const messageId = String(message?.messageId ?? "").trim()
  const scope = String(message?.accountScope || "")
  if (messageId && scope) return deliveryKey(provider, scope, `rfc:${messageId}`)
  const from = String(message?.from ?? "").replace(/\s+/g, " ").trim().toLowerCase()
  const subject = String(message?.subject ?? "").replace(/\s+/g, " ").trim().toLowerCase()
  return `mail-push:forwarded:${provider}:fallback:${await digestId(`${from}\n${subject}`)}`
}

async function deliveryKey(provider, accountId, messageId) {
  return `mail-push:delivery:${provider}:${await digestId(`${accountId}\n${messageId}`)}`
}

export async function handleForwardedEmail(message, env) {
  if (!env.MAIL_PUSH_STORE || !env.MAIL_PUSH_ENCRYPTION_KEY) {
    message.setReject("Mail push is not configured")
    return
  }
  const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
  if (!encrypted) {
    message.setReject("Mail push owner is not configured")
    return
  }
  const record = await open(encrypted, env)
  const provider = forwardedProvider(message.to)
  const messageId = String(message.headers.get("message-id") || "").trim()
  const scope = String(message.to || "").trim().toLowerCase()
  const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer())
  const rawDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBytes)), x => x.toString(16).padStart(2, "0")).join("")
  const dedupeKey = await deliveryKey("email", scope, messageId || `raw:${rawDigest}`)
  if (dedupeKey) {
    const existing = await env.MAIL_PUSH_STORE.get(dedupeKey)
    if (existing) {
      try {
        const state = JSON.parse(existing)?.state
        if (state === "pending" || state === "queued") throw new Error("PUSH_DELIVERY_PENDING")
        return
      } catch (error) {
        if (error?.message === "PUSH_DELIVERY_PENDING") throw error
        return
      }
    }
  }
  let from = String(message.headers.get("from") || message.from || "新邮件")
  let subject = String(message.headers.get("subject") || "无主题")
  let preview = "收到一封新邮件"
  try {
    const rawContent = decoder.decode(rawBytes)
    const parsed = await PostalMime.parse(rawContent)
    from = parsedSender(parsed, from)
    subject = String(parsed?.subject || subject)
    const parsedContent = await parsedBody(parsed)
    from = parsedContent.from || from
    subject = parsedContent.subject || subject
    const body = String(parsedContent.text || htmlToText(parsedContent.html)).trim()
    const code = forwardedVerificationCode(subject, body)
    const rawText = provider === "qq" ? rawContent : ""
    const link = provider === "qq" ? qqVerificationLink(rawText, message.to) : undefined
    preview = code ? `验证码：${code}` : link ? "点击此通知完成转发验证" : clipped(body, 160) || preview
    if (!body) {
      const separator = rawContent.match(/\r?\n\r?\n/)
      const bodyOffset = separator?.index === undefined ? rawContent.length : separator.index + separator[0].length
      const diagnostic = {
        provider,
        bytes: rawBytes.byteLength,
        bodyBytes: encoder.encode(rawContent.slice(bodyOffset)).byteLength,
        contentType: String(message.headers.get("content-type") || ""),
        transferEncoding: String(message.headers.get("content-transfer-encoding") || ""),
        mimeVersion: String(message.headers.get("mime-version") || ""),
        parsedText: Boolean(parsed?.text),
        parsedHtml: Boolean(parsed?.html),
        attachments: parsed?.attachments?.map(item => ({ mimeType: item?.mimeType, bytes: Number(item?.content?.byteLength ?? item?.content?.length ?? 0) })) ?? [],
        recordedAt: new Date().toISOString(),
      }
      console.warn("Forwarded MIME body empty", JSON.stringify(diagnostic))
      await env.MAIL_PUSH_STORE.put("mail-push:diagnostic:last-empty-mime", JSON.stringify(diagnostic), { expirationTtl: 30 * 60 })
    }
    if (link) {
      message.verificationAction = link
      await env.MAIL_PUSH_STORE.put("mail-push:verification:qq", link, { expirationTtl: 10 * 60 })
    }
  } catch (error) {
    console.error("Forwarded MIME parsing failed", String(error?.message ?? error))
  }
  // Cross-channel dedupe is allowed only with an explicit trusted forwarding route.
  let routeAccount
  try {
    const routes = JSON.parse(env.MAIL_PUSH_FORWARD_ROUTES || "{}")
    const accountId = routes[scope]
    routeAccount = record.accounts.find(a => a.id === accountId && a.provider === provider)
  } catch {}
  const accountScope = routeAccount ? `${provider}:${routeAccount.id}:${routeAccount.address}` : ""
  const primaryKey = accountScope && messageId ? await messageFingerprint(provider, { messageId, accountScope }) : dedupeKey
  await sendReservedPush(env.MAIL_PUSH_STORE, primaryKey, await activePushKey(record, env), { from, subject, preview, id: messageId, accountScope, action: message.verificationAction }, OUTBOX_TTL_SECONDS, env)
}

async function digestId(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
  return Array.from(bytes.subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function checkRecord(record, env, providers, accountIds) {
  let changed = false
  const now = Date.now()
  for (const account of record.accounts) {
    if (providers && !providers.has(account.provider)) continue
    if (accountIds && !accountIds.has(account.id)) continue
    if (account.nextCheckAt && Date.parse(account.nextCheckAt) > now) continue
    const previous = JSON.stringify(account)
    const previousCheckedAt = Date.parse(account.lastCheckedAt || "")
    const persistHeartbeat = !Number.isFinite(previousCheckedAt) || now - previousCheckedAt >= 60 * 60 * 1000
    try {
      const renewed = account.provider === "gmail" ? await refreshGoogle(account, env) : await refreshMicrosoft(account, env)
      account.refreshToken = renewed.refreshToken
      const result = await discoverMessages(account, renewed.accessToken, 15)
      const scope = `${account.provider}:${account.id}:${account.address}`
      for (const message of result.messages) {
        if ((account.notifiedIds || []).includes(message.id)) continue
        message.accountScope = scope
        const key = message.messageId ? await messageFingerprint(account.provider, message) : await deliveryKey(account.provider, scope, message.id)
        await sendReservedPush(env.MAIL_PUSH_STORE, key, await activePushKey(record, env), message, OUTBOX_TTL_SECONDS, env)
      }
      // Discovery checkpoint only advances after every message is durably queued.
      Object.assign(account, result.checkpoint)
      account.pendingSync = result.more
      if (result.more && env.MAIL_PUSH_WAKE) await env.MAIL_PUSH_WAKE()
      account.lastError = ""
      account.failureCount = 0
      account.nextCheckAt = result.more ? "" : new Date(now + 3 * 60_000).toISOString()
      if (persistHeartbeat) account.lastCheckedAt = new Date(now).toISOString()
    } catch (error) {
      account.failureCount = Math.min(Number(account.failureCount || 0) + 1, 10)
      const delayMinutes = Math.min(2 ** (account.failureCount - 1), 60)
      account.nextCheckAt = new Date(now + delayMinutes * 60_000).toISOString()
      account.lastError = String(error?.message ?? error).slice(0, 80)
      account.lastCheckedAt = new Date().toISOString()
      console.error("Background account check failed", account.provider, account.lastError)
    }
    if (JSON.stringify(account) !== previous) changed = true
  }
  return changed
}

export async function handleBackgroundPush(request, env, pathname, jsonResponse) {
  if (!env.MAIL_PUSH_STORE) return jsonResponse({ error: { code: "NOT_CONFIGURED", message: "后台推送存储尚未配置" } }, 503)
  if (!authorized(request, env)) return jsonResponse({ error: { code: "UNAUTHORIZED", message: "未授权" } }, 401)
  let body = {}
  if (request.method !== "GET") {
    try { body = await jsonBody(request) } catch (error) {
      return jsonResponse({ error: { code: error.message === "UNSUPPORTED_MEDIA_TYPE" ? "UNSUPPORTED_MEDIA_TYPE" : "INVALID_REQUEST", message: "请求格式无效" } }, error.message === "UNSUPPORTED_MEDIA_TYPE" ? 415 : 400)
    }
  }
  if (request.method === "PUT" && pathname === "/v1/push/config") {
    try {
      const pushKey = String(body?.pushKey ?? "").trim()
      if (pushKey.length < 20 || pushKey.length > 512) throw new Error("INVALID_PUSH_KEY")
      await seal({ probe: true }, env)
      const existingEncrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
      const existing = existingEncrypted ? await open(existingEncrypted, env) : undefined
      const accountsProvided = Array.isArray(body?.accounts)
      const accounts = accountsProvided ? body.accounts.map(accountFromInput) : []
      if (accountsProvided && (accounts.length > 12 || new Set(accounts.map(a => a.id)).size !== accounts.length)) throw new Error("INVALID_ACCOUNTS")
      const previousById = new Map((existing?.accounts ?? []).map(account => [account.id, account]))
      const removedMicrosoftAccounts = accountsProvided
        ? (existing?.accounts ?? []).filter(account => account.provider === "microsoft" && !accounts.some(a => a.id === account.id && a.provider === account.provider && a.address === account.address))
        : []
      const mergedAccounts = accountsProvided ? accounts.map(account => {
        const previous = previousById.get(account.id)
        if (!previous || previous.provider !== account.provider || previous.address !== account.address) return { ...account, pushEnabledAt: new Date().toISOString() }
        return {
          ...previous,
          ...account,
          pendingSync: previous.pendingSync,
          newestId: previous.newestId || account.newestId,
          notifiedIds: previous.notifiedIds,
          lastError: "",
          lastCheckedAt: previous.lastCheckedAt,
          failureCount: 0,
          nextCheckAt: "",
          microsoftSubscriptionId: previous.microsoftSubscriptionId,
          microsoftSubscriptionExpiresAt: previous.microsoftSubscriptionExpiresAt,
          microsoftClientState: previous.microsoftClientState,
        }
      }) : (existing?.accounts ?? [])
      for (const account of mergedAccounts.filter(item => item.provider === "microsoft")) {
        if (!account.microsoftClientState) account.microsoftClientState = bytesToBase64(crypto.getRandomValues(new Uint8Array(24)))
      }
      const record = { version: 2, pushKey, accounts: mergedAccounts, updatedAt: new Date().toISOString() }
      // Subscription creation is deferred until after this configuration is durable.
      const sealedPushKey = await seal({ pushKey }, env)
      const sealedRecord = await seal(record, env)
      if (typeof env.MAIL_PUSH_STORE.putMany === "function") {
        await env.MAIL_PUSH_STORE.putMany({
          [PUSH_KEY_KEY]: { value: sealedPushKey },
          [CONFIG_KEY]: { value: sealedRecord },
        })
      } else {
        await env.MAIL_PUSH_STORE.put(PUSH_KEY_KEY, sealedPushKey)
        await env.MAIL_PUSH_STORE.put(CONFIG_KEY, sealedRecord)
      }
      for (const removed of removedMicrosoftAccounts) await deleteMicrosoftSubscription(removed, env)
      return jsonResponse({ data: { enabled: true, accountCount: mergedAccounts.length, accounts: mergedAccounts.map(account => ({ id: account.id, provider: account.provider, active: !account.lastError, lastCheckedAt: account.lastCheckedAt, nextCheckAt: account.nextCheckAt, lastError: account.lastError })) } })
    } catch (error) {
      console.error("Background push configuration failed", String(error?.message ?? error).replace(/[^A-Z0-9_ -]/gi, ""))
      return jsonResponse({ error: { code: "CONFIGURATION_FAILED", message: "后台推送配置失败，请检查邮箱授权" } }, 400)
    }
  }

  if (request.method === "GET" && pathname === "/v1/push/config") {
    const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
    if (!encrypted) return jsonResponse({ data: { enabled: false, accountCount: 0 } })
    const record = await open(encrypted, env)
    return jsonResponse({ data: { enabled: true, accountCount: record.accounts.length, accounts: record.accounts.map(account => ({ id: account.id, provider: account.provider, active: !account.lastError, lastCheckedAt: account.lastCheckedAt, nextCheckAt: account.nextCheckAt, lastError: account.lastError })) } })
  }

  if (request.method === "POST" && pathname === "/v1/push/test") {
    const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
    if (!encrypted) return jsonResponse({ error: { code: "NOT_ENABLED", message: "后台推送尚未启用" } }, 400)
    const record = await open(encrypted, env)
    const nonce = crypto.randomUUID()
    try {
      const result = await sendPush(await activePushKey(record, env), { from: "云邮管家", subject: "后台推送诊断", preview: `诊断编号：${nonce}` })
      return jsonResponse({ data: { deliveredTo: result.targets ?? 1, nonce } })
    } catch (error) {
      console.error("Test push failed", error)
      return jsonResponse({ error: { code: "PUSH_FAILED", message: `推送发送失败：${error?.message || error}` } }, 502)
    }
  }

  if (request.method === "DELETE" && pathname === "/v1/push/config") {
    const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
    if (encrypted) {
      const record = await open(encrypted, env)
      for (const account of record.accounts.filter(item => item.provider === "microsoft")) await deleteMicrosoftSubscription(account, env)
    }
    // Remove pending notifications before enabling a future configuration.
    for (const task of await env.MAIL_PUSH_STORE.list(OUTBOX_PREFIX)) await env.MAIL_PUSH_STORE.delete(task.key)
    await env.MAIL_PUSH_STORE.delete(CONFIG_KEY)
    await env.MAIL_PUSH_STORE.delete(PUSH_KEY_KEY)
    return jsonResponse({ data: { enabled: false, deleted: true } })
  }
  return null
}

export async function handleCloudMailWebhook(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405 })
  if (!env.CLOUD_MAIL_WEBHOOK_SECRET || request.headers.get("authorization") !== `Bearer ${env.CLOUD_MAIL_WEBHOOK_SECRET}`) return new Response(null, { status: 401 })
  if (!env.MAIL_PUSH_STORE || !env.MAIL_PUSH_ENCRYPTION_KEY) return new Response(null, { status: 503 })
  const declaredLength = Number(request.headers.get("content-length") || 0)
  if (declaredLength > 32_768) return new Response(null, { status: 413 })
  let payload
  try { payload = await jsonBody(request, 32_768) } catch (error) {
    return new Response(null, { status: error?.message === "PAYLOAD_TOO_LARGE" ? 413 : 400 })
  }
  const id = typeof payload?.id === "string" ? payload.id : ""
  if (!id.trim() || id.length > 1024) return new Response(null, { status: 400 })
  const dedupeKey = await deliveryKey("cloud-mail", "owner", id)
  const existing = await env.MAIL_PUSH_STORE.get(dedupeKey)
  if (existing) {
    try {
      const state = JSON.parse(existing)?.state
      if (state === "pending" || state === "queued") return new Response(null, { status: 503 })
    } catch {}
    return new Response(null, { status: 204 })
  }
  const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
  if (!encrypted) return new Response(null, { status: 202 })
  const record = await open(encrypted, env)
  const code = clipped(payload?.code, 20)
  const delivery = await sendReservedPush(env.MAIL_PUSH_STORE, dedupeKey, await activePushKey(record, env), {
    id,
    from: clipped(payload?.from, 160),
    subject: clipped(payload?.subject, 200),
    preview: code ? `验证码：${code}` : clipped(payload?.preview, 500),
  }, 7 * 24 * 60 * 60, env)
  if (delivery.pending) return new Response(null, { status: 503 })
  return new Response(null, { status: 204 })
}

export async function handleMicrosoftWebhook(request, env, context) {
  const requestURL = new URL(request.url)
  const validationToken = requestURL.searchParams.get("validationToken")
  if (validationToken !== null) return new Response(validationToken, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  if (request.method !== "POST" || !env.MAIL_PUSH_STORE || !env.MAIL_PUSH_ENCRYPTION_KEY) return new Response(null, { status: 405 })
  let payload
  try { payload = await jsonBody(request, 65_536) } catch (error) {
    return new Response(null, { status: error?.message === "PAYLOAD_TOO_LARGE" ? 413 : 400 })
  }
  const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
  if (!encrypted) return new Response(null, { status: 202 })
  const record = await open(encrypted, env)
  const notifications = Array.isArray(payload?.value) ? payload.value : []
  if (!notifications.length || notifications.length > 50) return new Response(null, { status: 400 })
  const matched = []
  for (const item of notifications) {
    const account = record.accounts.find(a => a.provider === "microsoft" && a.microsoftSubscriptionId && a.microsoftSubscriptionId === String(item?.subscriptionId ?? "") && a.microsoftClientState && a.microsoftClientState === String(item?.clientState ?? ""))
    if (!account) return new Response(null, { status: 401 })
    matched.push(account)
  }
  for (const account of matched) { account.pendingSync = true; if (!account.failureCount) account.nextCheckAt = "" }
  // Persist before acknowledgement; alarms can recover a lost in-memory task.
  if (env.MAIL_PUSH_WAKE) await env.MAIL_PUSH_WAKE()
  await env.MAIL_PUSH_STORE.put(CONFIG_KEY, await seal(record, env))
  const providers = new Set(["microsoft"])
  const accountIds = new Set(record.accounts.filter(a => a.pendingSync).map(a => a.id))
  if (context?.schedule) await context.schedule(() => runBackgroundChecks(env, providers, accountIds))
  else if (context?.waitUntil) context.waitUntil(runBackgroundChecks(env, providers, accountIds))
  else await runBackgroundChecks(env, providers, accountIds)
  return new Response(null, { status: 202 })
}

const outbox = createOutbox({ seal, open, sendPush, digestId, activePushKey })
async function sendReservedPush(store, key, pushKey, message, ttl, env) {
  return outbox.enqueue(env, key, message, ttl)
}
export async function drainPendingPushes(env) {
  const raw = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
  return raw ? outbox.drain(env, await open(raw,env),10) : 0
}
export async function nextPushWake(env) { return outbox.nextWake(env) }

export async function runBackgroundChecks(env, providers, accountIds) {
  if (!env.MAIL_PUSH_STORE || !env.MAIL_PUSH_ENCRYPTION_KEY) return
  try {
    const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
    if (!encrypted) return
    const record = await open(encrypted, env)
    const due = record.accounts.filter(a => (!providers || providers.has(a.provider)) && (!accountIds || accountIds.has(a.id)) && (!a.nextCheckAt || Date.parse(a.nextCheckAt) <= Date.now()))
    due.sort((a,b) => Number(a.lastAttemptAt || 0)-Number(b.lastAttemptAt || 0))
    const selected = due[0]
    const selectedIds = new Set(selected ? [selected.id] : [])
    if (selected) selected.lastAttemptAt = Date.now()
    let changed = Boolean(selected)
    for (const account of record.accounts.filter(item => item.provider === "microsoft" && selectedIds.has(item.id))) {
      try { if (await ensureMicrosoftSubscription(account, env)) changed = true }
      catch (error) { account.lastError = String(error?.message ?? error).slice(0, 80); changed = true }
    }
    if (await checkRecord(record, env, providers, selectedIds)) changed = true
    if (due.length > 1 && env.MAIL_PUSH_WAKE) await env.MAIL_PUSH_WAKE()
    if (changed) {
      record.updatedAt = new Date().toISOString()
      const latestEncrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
      const latest = latestEncrypted ? await open(latestEncrypted, env) : undefined
      if (latest?.pushKey) record.pushKey = latest.pushKey
      await env.MAIL_PUSH_STORE.put(CONFIG_KEY, await seal(record, env))
    }
  } catch (error) {
    console.error("Background mailbox check failed", String(error?.message ?? error).replace(/[^A-Z0-9_ -]/gi, ""))
  }
}
