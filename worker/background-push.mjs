import PostalMime from "postal-mime"

const PUSH_ENDPOINT = "https://push.scripting.fun/push"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
const GRAPH_API = "https://graph.microsoft.com/v1.0/me"
const CONFIG_KEY = "mail-push:owner-config:v2"
const MICROSOFT_WEBHOOK_PATH = "/v1/webhooks/microsoft/mail"
const MICROSOFT_SUBSCRIPTION_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000
const MICROSOFT_RENEW_WINDOW_MS = 12 * 60 * 60 * 1000
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

async function refreshGoogle(account, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("Google OAuth configuration is incomplete")
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET })
  const response = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body })
  const payload = await response.json()
  if (!response.ok || !payload?.access_token) throw new Error("GMAIL_REFRESH_FAILED")
  return { accessToken: String(payload.access_token), refreshToken: String(payload.refresh_token || account.refreshToken) }
}

async function refreshMicrosoft(account, env) {
  if (!env.MICROSOFT_CLIENT_ID) throw new Error("Microsoft OAuth configuration is incomplete")
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: env.MICROSOFT_CLIENT_ID, scope: "openid profile email offline_access User.Read Mail.ReadWrite" })
  if (env.MICROSOFT_CLIENT_SECRET) body.set("client_secret", env.MICROSOFT_CLIENT_SECRET)
  const response = await fetch(MICROSOFT_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body })
  const payload = await response.json()
  if (!response.ok || !payload?.access_token) throw new Error("MICROSOFT_REFRESH_FAILED")
  return { accessToken: String(payload.access_token), refreshToken: String(payload.refresh_token || account.refreshToken) }
}

function gmailHeader(message, name) {
  return String(message?.payload?.headers?.find(item => String(item?.name).toLowerCase() === name)?.value ?? "")
}

async function gmailMessages(account, env) {
  const renewed = await refreshGoogle(account, env)
  account.refreshToken = renewed.refreshToken
  const headers = { Authorization: `Bearer ${renewed.accessToken}`, Accept: "application/json" }
  const listResponse = await fetch(`${GMAIL_API}/messages?labelIds=INBOX&maxResults=10`, { headers })
  const list = await listResponse.json()
  if (!listResponse.ok) throw new Error("GMAIL_LIST_FAILED")
  const ids = (list.messages ?? []).map(item => String(item.id)).filter(Boolean)
  const boundary = account.newestId ? ids.indexOf(account.newestId) : -1
  // An empty cursor establishes a baseline. If a later cursor falls outside the
  // bounded window, notify the newest messages instead of silently skipping all.
  const newIds = !account.newestId ? [] : boundary >= 0 ? ids.slice(0, boundary) : ids.slice(0, 5)
  const messages = []
  for (const id of newIds.slice(0, 5).reverse()) {
    const response = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers })
    const value = await response.json()
    if (!response.ok) throw new Error("GMAIL_MESSAGE_FAILED")
    messages.push({ id, from: gmailHeader(value, "from"), subject: gmailHeader(value, "subject"), preview: String(value.snippet ?? "") })
  }
  return { messages, newestId: ids[0] || account.newestId }
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

async function microsoftMessages(account, env) {
  const renewed = await refreshMicrosoft(account, env)
  account.refreshToken = renewed.refreshToken
  const query = new URLSearchParams({ "$top": "10", "$orderby": "receivedDateTime desc", "$select": "id,subject,from,bodyPreview" })
  const response = await fetch(`${GRAPH_API}/mailFolders/inbox/messages?${query}`, { headers: { Authorization: `Bearer ${renewed.accessToken}`, Accept: "application/json" } })
  const payload = await response.json()
  if (!response.ok) throw new Error("MICROSOFT_LIST_FAILED")
  const values = Array.isArray(payload.value) ? payload.value : []
  const boundary = account.newestId ? values.findIndex(item => String(item.id) === account.newestId) : -1
  const incoming = !account.newestId ? [] : boundary >= 0 ? values.slice(0, boundary) : values.slice(0, 5)
  const messages = incoming.slice(0, 5).reverse().map(item => ({ id: String(item.id), from: String(item?.from?.emailAddress?.name || item?.from?.emailAddress?.address || ""), subject: String(item?.subject ?? ""), preview: String(item?.bodyPreview ?? "") }))
  return { messages, newestId: String(values[0]?.id ?? account.newestId) }
}

function clipped(value, maximum) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim()
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized
}

async function sendPush(pushKey, message) {
  const sender = clipped(message.from, 80) || "新邮件"
  const subject = clipped(message.subject, 120) || "无主题"
  const preview = clipped(message.preview, 160)
  const response = await fetch(PUSH_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${pushKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ title: sender, body: preview ? `${subject}\n${preview}` : subject, action: message.action || "scripting://run/云邮管家", icon: "envelope.badge.fill", iconColor: "systemBlue", sound: "default", interruptionLevel: "active" }),
  })
  if (!response.ok) throw new Error(`REMOTE_PUSH_FAILED_${response.status}`)
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

function forwardedVerificationCode(subject, body) {
  const source = `${subject}\n${body}`
  if (!/(?:验证码|校验码|动态码|登录码|安全码|verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP)/i.test(source)) return ""
  return source.match(/(?:验证码|校验码|动态码|登录码|安全码|verification\s*code|security\s*code|login\s*code|passcode|OTP)[^A-Z0-9]{0,24}([A-Z0-9]{4,10})/i)?.[1] ?? ""
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
  const from = String(message?.from ?? "").replace(/\s+/g, " ").trim().toLowerCase()
  const subject = String(message?.subject ?? "").replace(/\s+/g, " ").trim().toLowerCase()
  return `mail-push:forwarded:${provider}:${await digestId(`${from}\n${subject}`)}`
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
  const messageId = String(message.headers.get("message-id") || "").trim()
  const dedupeKey = messageId ? `mail-push:email:${await digestId(messageId)}` : ""
  if (dedupeKey && await env.MAIL_PUSH_STORE.get(dedupeKey)) return
  let from = String(message.headers.get("from") || message.from || "新邮件")
  let subject = String(message.headers.get("subject") || "无主题")
  const provider = forwardedProvider(message.to)
  let preview = "收到一封新邮件"
  try {
    const raw = await new Response(message.raw).arrayBuffer()
    const rawBytes = new Uint8Array(raw)
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
  await sendPush(record.pushKey, { from, subject, preview, id: messageId, action: message.verificationAction })
  await env.MAIL_PUSH_STORE.put(await messageFingerprint(provider, { from, subject }), "1", { expirationTtl: 10 * 60 })
  if (dedupeKey) await env.MAIL_PUSH_STORE.put(dedupeKey, "1", { expirationTtl: 7 * 24 * 60 * 60 })
}

async function digestId(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
  return Array.from(bytes.subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function checkRecord(record, env) {
  let changed = false
  const now = Date.now()
  for (const account of record.accounts) {
    if (account.nextCheckAt && Date.parse(account.nextCheckAt) > now) continue
    try {
      const result = account.provider === "gmail" ? await gmailMessages(account, env) : await microsoftMessages(account, env)
      const notifiedIds = Array.isArray(account.notifiedIds) ? account.notifiedIds : []
      for (const message of result.messages) {
        if (notifiedIds.includes(message.id)) continue
        const forwarded = account.provider === "gmail" && await env.MAIL_PUSH_STORE.get(await messageFingerprint("gmail", message))
        if (!forwarded) await sendPush(record.pushKey, message)
        notifiedIds.push(message.id)
        account.notifiedIds = notifiedIds.slice(-50)
        changed = true
      }
      if (result.newestId && result.newestId !== account.newestId) {
        account.newestId = result.newestId
        changed = true
      }
      account.lastError = ""
      account.failureCount = 0
      account.nextCheckAt = ""
      account.lastCheckedAt = new Date().toISOString()
      changed = true
    } catch (error) {
      account.failureCount = Math.min(Number(account.failureCount || 0) + 1, 10)
      const delayMinutes = Math.min(2 ** (account.failureCount - 1), 60)
      account.nextCheckAt = new Date(now + delayMinutes * 60_000).toISOString()
      account.lastError = String(error?.message ?? error).slice(0, 80)
      account.lastCheckedAt = new Date().toISOString()
      changed = true
    }
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
      const accounts = Array.isArray(body?.accounts) ? body.accounts.map(accountFromInput) : []
      if (!accounts.length || accounts.length > 12) throw new Error("INVALID_ACCOUNTS")
      const existingEncrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
      const existing = existingEncrypted ? await open(existingEncrypted, env) : undefined
      const previousById = new Map((existing?.accounts ?? []).map(account => [account.id, account]))
      const mergedAccounts = accounts.map(account => {
        const previous = previousById.get(account.id)
        if (!previous || previous.provider !== account.provider || previous.address !== account.address) return account
        return {
          ...account,
          newestId: previous.newestId || account.newestId,
          notifiedIds: previous.notifiedIds,
          lastError: previous.lastError,
          lastCheckedAt: previous.lastCheckedAt,
          failureCount: previous.failureCount,
          nextCheckAt: previous.nextCheckAt,
          microsoftSubscriptionId: previous.microsoftSubscriptionId,
          microsoftSubscriptionExpiresAt: previous.microsoftSubscriptionExpiresAt,
          microsoftClientState: previous.microsoftClientState,
        }
      })
      for (const account of mergedAccounts.filter(item => item.provider === "microsoft")) {
        if (!account.microsoftClientState) account.microsoftClientState = bytesToBase64(crypto.getRandomValues(new Uint8Array(24)))
      }
      const record = { version: 2, pushKey, accounts: mergedAccounts, updatedAt: new Date().toISOString() }
      await env.MAIL_PUSH_STORE.put(CONFIG_KEY, await seal(record, env))
      for (const account of mergedAccounts.filter(item => item.provider === "microsoft")) {
        try { await ensureMicrosoftSubscription(account, env) }
        catch (error) { account.lastError = String(error?.message ?? error).slice(0, 80) }
      }
      await env.MAIL_PUSH_STORE.put(CONFIG_KEY, await seal(record, env))
      return jsonResponse({ data: { enabled: true, accountCount: mergedAccounts.length, accounts: mergedAccounts.map(account => ({ id: account.id, provider: account.provider, active: !account.lastError })) } })
    } catch (error) {
      console.error("Background push configuration failed", String(error?.message ?? error).replace(/[^A-Z0-9_ -]/gi, ""))
      return jsonResponse({ error: { code: "CONFIGURATION_FAILED", message: "后台推送配置失败，请检查邮箱授权" } }, 400)
    }
  }

  if (request.method === "GET" && pathname === "/v1/push/config") {
    const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
    if (!encrypted) return jsonResponse({ data: { enabled: false, accountCount: 0 } })
    const record = await open(encrypted, env)
    return jsonResponse({ data: { enabled: true, accountCount: record.accounts.length, accounts: record.accounts.map(account => ({ id: account.id, provider: account.provider, active: !account.lastError, lastCheckedAt: account.lastCheckedAt })) } })
  }

  if (request.method === "DELETE" && pathname === "/v1/push/config") {
    await env.MAIL_PUSH_STORE.delete(CONFIG_KEY)
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
  const id = clipped(payload?.id, 160)
  if (!id) return new Response(null, { status: 400 })
  const dedupeKey = `mail-push:cloud-mail:${await digestId(id)}`
  if (await env.MAIL_PUSH_STORE.get(dedupeKey)) return new Response(null, { status: 204 })
  const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
  if (!encrypted) return new Response(null, { status: 202 })
  const record = await open(encrypted, env)
  const code = clipped(payload?.code, 20)
  await sendPush(record.pushKey, {
    id,
    from: clipped(payload?.from, 160),
    subject: clipped(payload?.subject, 200),
    preview: code ? `验证码：${code}` : clipped(payload?.preview, 500),
  })
  await env.MAIL_PUSH_STORE.put(dedupeKey, "1", { expirationTtl: 7 * 24 * 60 * 60 })
  return new Response(null, { status: 204 })
}

export async function handleMicrosoftWebhook(request, env, context) {
  const requestURL = new URL(request.url)
  const validationToken = requestURL.searchParams.get("validationToken")
  if (validationToken !== null) return new Response(validationToken, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  if (request.method !== "POST" || !env.MAIL_PUSH_STORE || !env.MAIL_PUSH_ENCRYPTION_KEY) return new Response(null, { status: 405 })
  let payload
  try { payload = await request.json() } catch { return new Response(null, { status: 400 }) }
  const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
  if (!encrypted) return new Response(null, { status: 202 })
  const record = await open(encrypted, env)
  const expectedStates = new Set(record.accounts.filter(account => account.provider === "microsoft").map(account => account.microsoftClientState).filter(Boolean))
  const notifications = Array.isArray(payload?.value) ? payload.value : []
  if (!notifications.length || notifications.some(item => !expectedStates.has(String(item?.clientState ?? "")))) return new Response(null, { status: 401 })
  if (context?.waitUntil) context.waitUntil(runBackgroundChecks(env))
  else await runBackgroundChecks(env)
  return new Response(null, { status: 202 })
}

export async function runBackgroundChecks(env) {
  if (!env.MAIL_PUSH_STORE || !env.MAIL_PUSH_ENCRYPTION_KEY) return
  try {
    const encrypted = await env.MAIL_PUSH_STORE.get(CONFIG_KEY)
    if (!encrypted) return
    const record = await open(encrypted, env)
    let changed = false
    for (const account of record.accounts.filter(item => item.provider === "microsoft")) {
      try { if (await ensureMicrosoftSubscription(account, env)) changed = true }
      catch (error) { account.lastError = String(error?.message ?? error).slice(0, 80); changed = true }
    }
    if (await checkRecord(record, env)) changed = true
    if (changed) {
      record.updatedAt = new Date().toISOString()
      await env.MAIL_PUSH_STORE.put(CONFIG_KEY, await seal(record, env))
    }
  } catch (error) {
    console.error("Background mailbox check failed", String(error?.message ?? error).replace(/[^A-Z0-9_ -]/gi, ""))
  }
}
