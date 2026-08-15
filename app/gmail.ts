import { Script } from "scripting"
import type { GmailOAuthSecret, MailAccount, MailAttachment, MailMessage } from "./models"
import { unsubscribeFromHeaders, unsubscribeFromHtml } from "./unsubscribe"
import { loadAccounts, loadSecret, saveAccounts, saveSecret } from "./store"
import { GMAIL_OAUTH_RELAY, gmailOAuthConfigured } from "./gmail-config"

export { gmailOAuthConfigured } from "./gmail-config"

type RequestInit = { method?: string; headers?: Record<string, string>; body?: string }
declare function fetch(url: string, init?: RequestInit): Promise<any>

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
const GMAIL_SCOPE = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify"
const CALLBACK_ID = "gmail-cloud-mail-manager"

function relayOrigin() {
  if (!gmailOAuthConfigured()) throw new Error("Gmail 登录服务尚未部署，请先完成内部 OAuth 配置")
  return GMAIL_OAUTH_RELAY.origin.trim().replace(/\/+$/, "")
}

function oauth(relaySecret: string) {
  const origin = relayOrigin()
  const helper = new OAuth2({
    consumerKey: "relay",
    consumerSecret: relaySecret,
    authorizeUrl: `${origin}/oauth/google/authorize`,
    accessTokenUrl: `${origin}/oauth/google/token`,
    responseType: "code",
    contentType: "application/x-www-form-urlencoded",
  })
  helper.allowMissingStateCheck = false
  return helper
}

function base64URL(value: string) {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function randomToken() {
  return base64URL(Crypto.generateSymmetricKey(256).toBase64String())
}

function loadGmailSecret(accountId: string): GmailOAuthSecret | undefined {
  const raw = loadSecret(accountId)
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw)
    if (value?.version === 1 && typeof value.relaySecret === "string") return value
  } catch {}
  return undefined
}

function saveGmailSecret(accountId: string, value?: GmailOAuthSecret) {
  saveSecret(accountId, value ? JSON.stringify(value) : "")
}

export function isGmailAuthorized(accountId: string) {
  const value = loadGmailSecret(accountId)
  return Boolean(value?.credential?.oauthRefreshToken || value?.credential?.oauthToken)
}

function readableAuthError(error: unknown) {
  const message = String((error as any)?.message ?? error)
  if (/cancel|canceled|cancelled|denied|access_denied/i.test(message)) return "已取消 Google 登录，未添加账号"
  if (/network|offline|internet|timed? ?out|fetch/i.test(message)) return "无法连接 Google，请检查网络后重试"
  if (/redirect_uri_mismatch/i.test(message)) return "Google 登录回调配置不正确，请更新云邮管家"
  if (/invalid_client|unauthorized_client/i.test(message)) return "Google 登录服务配置无效，请更新云邮管家"
  return `Google 登录失败：${message}`
}

export async function authorizeGmail(account: MailAccount): Promise<MailAccount> {
  if (!gmailOAuthConfigured()) throw new Error("此版本尚未开通 Google 登录，请更新云邮管家")
  const relaySecret = GMAIL_OAUTH_RELAY.clientSecret
  let credential: OAuthCredential
  try {
    credential = await oauth(relaySecret).authorize({
      callbackURL: Script.createOAuthCallbackURLScheme(CALLBACK_ID),
      scope: GMAIL_SCOPE,
      state: randomToken(),
      parameters: { access_type: "offline", include_granted_scopes: "true", prompt: "consent" },
    })
  } catch (error) {
    throw new Error(readableAuthError(error))
  }
  if (!credential.oauthToken) throw new Error("Google 未返回访问令牌")
  if (!credential.oauthRefreshToken) throw new Error("Google 未返回刷新令牌，请撤销应用授权后重试")
  saveGmailSecret(account.id, { version: 1, relaySecret: relaySecret.trim(), credential })

  try {
    const profile = await gmailJSON(account, "/profile")
    const address = String(profile?.emailAddress ?? account.address).trim()
    if (!address) throw new Error("Google 未返回 Gmail 地址")
    const accounts = loadAccounts()
    const existing = accounts.find(item => item.provider === "gmail" && item.id !== account.id && item.address.toLowerCase() === address.toLowerCase())
    const updated: MailAccount = {
      ...(existing ?? account),
      name: existing?.name || account.name || "Gmail",
      address,
      gmailHistoryId: String(profile?.historyId ?? "") || existing?.gmailHistoryId || account.gmailHistoryId,
      enabled: true,
    }
    if (existing) {
      saveGmailSecret(existing.id, { version: 1, relaySecret: relaySecret.trim(), credential })
      saveGmailSecret(account.id)
    }
    const index = accounts.findIndex(item => item.id === updated.id)
    if (index >= 0) accounts[index] = updated
    else accounts.push(updated)
    saveAccounts(accounts)
    return updated
  } catch (error) {
    saveGmailSecret(account.id)
    throw new Error(`Google 已授权，但读取 Gmail 账号失败：${String((error as any)?.message ?? error)}`)
  }
}

export function disconnectGmail(accountId: string) {
  saveGmailSecret(accountId)
}

async function accessToken(account: MailAccount, forceRefresh = false) {
  const saved = loadGmailSecret(account.id)
  if (!saved?.credential) throw new Error("请先连接 Google 账号")
  const expiresAt = saved.credential.oauthTokenExpiresAt ?? 0
  if (!forceRefresh && saved.credential.oauthToken && (!expiresAt || expiresAt > Date.now() + 60_000)) return saved.credential.oauthToken
  if (!saved.credential.oauthRefreshToken) throw new Error("Google 授权已失效，请重新连接")
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: saved.credential.oauthRefreshToken,
      client_id: "relay",
      client_secret: saved.relaySecret || GMAIL_OAUTH_RELAY.clientSecret,
    })
    const response = await fetch(`${relayOrigin()}/oauth/google/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    const raw = await response.text()
    let renewed: any
    try { renewed = raw ? JSON.parse(raw) : {} } catch { renewed = { error_description: raw } }
    if (!response.ok || !renewed?.access_token) {
      throw new Error(renewed?.error_description || renewed?.error || `HTTP ${response.status}`)
    }
    const credential: OAuthCredential = {
      ...saved.credential,
      oauthToken: String(renewed.access_token),
      oauthRefreshToken: String(renewed.refresh_token || saved.credential.oauthRefreshToken),
      oauthTokenExpiresAt: renewed.expires_in ? Date.now() + Number(renewed.expires_in) * 1000 : saved.credential.oauthTokenExpiresAt,
    }
    saveGmailSecret(account.id, { ...saved, credential })
    return credential.oauthToken
  } catch (error) {
    const message = String((error as any)?.message ?? error)
    if (/invalid_grant|revoked/i.test(message)) saveGmailSecret(account.id)
    throw new Error(/invalid_grant|revoked/i.test(message) ? "Google 授权已撤销，请重新连接" : `Google 令牌刷新失败：${message}`)
  }
}

async function gmailJSON(account: MailAccount, path: string, init: RequestInit = {}, retried = false): Promise<any> {
  const token = await accessToken(account, retried)
  const response = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
  })
  if (response.status === 401 && !retried) return gmailJSON(account, path, init, true)
  const raw = await response.text()
  let payload: any
  try { payload = raw ? JSON.parse(raw) : {} } catch { throw new Error(`Gmail API 返回异常（HTTP ${response.status}）`) }
  if (!response.ok) throw new Error(payload?.error?.message ?? `Gmail API 请求失败（HTTP ${response.status}）`)
  return payload
}

function decodeBase64URL(value: string) {
  if (!value) return ""
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const source = value.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "")
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of source) {
    const index = alphabet.indexOf(character)
    if (index < 0) continue
    buffer = (buffer << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  let encoded = ""
  for (const byte of bytes) encoded += `%${byte.toString(16).padStart(2, "0")}`
  try { return decodeURIComponent(encoded) }
  catch { return bytes.map(byte => String.fromCharCode(byte)).join("") }
}

function header(payload: any, name: string) {
  const item = Array.isArray(payload?.headers) ? payload.headers.find((entry: any) => String(entry?.name).toLowerCase() === name.toLowerCase()) : undefined
  return String(item?.value ?? "")
}

function collectParts(part: any, result: { html: string[]; plain: string[]; attachments: MailAttachment[] }) {
  const mimeType = String(part?.mimeType ?? "").toLowerCase()
  const filename = String(part?.filename ?? "")
  const attachmentId = String(part?.body?.attachmentId ?? "")
  if (filename || attachmentId) {
    result.attachments.push({ id: attachmentId || filename, filename: filename || "附件", mimeType: mimeType || "application/octet-stream", size: Number(part?.body?.size ?? 0), key: attachmentId })
  } else if (part?.body?.data) {
    const content = decodeBase64URL(String(part.body.data))
    if (mimeType === "text/html") result.html.push(content)
    else if (mimeType === "text/plain") result.plain.push(content)
  }
  for (const child of Array.isArray(part?.parts) ? part.parts : []) collectParts(child, result)
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    try { return String.fromCodePoint(point) } catch { return match }
  })
}

function stripHtml(value: string) {
  return decodeHtmlEntities(value.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

function verificationCode(subject: string, body: string) {
  const source = `${subject}\n${body}`
  if (!/(?:验证码|校验码|动态码|登录码|安全码|verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP)/i.test(source)) return undefined
  const patterns = [/(?:验证码|校验码|动态码|登录码|安全码)[^A-Z0-9]{0,20}([A-Z0-9]{4,8})/i, /(?:verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP)[^A-Z0-9]{0,24}([A-Z0-9]{4,8})/i, /([A-Z0-9]{4,8})[^A-Z0-9]{0,20}(?:is your (?:verification|security|login) code)/i]
  for (const pattern of patterns) { const value = source.match(pattern)?.[1]; if (value && /\d/.test(value)) return value }
  return undefined
}

function normalizeGmailMessage(raw: any, account: MailAccount): MailMessage {
  const parts = { html: [] as string[], plain: [] as string[], attachments: [] as MailAttachment[] }
  collectParts(raw?.payload ?? {}, parts)
  // multipart/alternative can contain several representations; rendering every HTML part
  // together duplicates the message and can mix unrelated MIME sections.
  const htmlCandidates = parts.html.map(item => item.trim()).filter(Boolean)
  const html = htmlCandidates.length ? htmlCandidates[htmlCandidates.length - 1] : ""
  const plain = parts.plain.map(item => item.trim()).filter(Boolean).join("\n\n")
  const body = plain || stripHtml(html) || String(raw?.snippet ?? "")
  const subject = header(raw?.payload, "Subject") || "（无主题）"
  const internalDate = Number(raw?.internalDate ?? 0)
  const unsubscribe = unsubscribeFromHeaders(
    header(raw?.payload, "List-Unsubscribe"),
    header(raw?.payload, "List-Unsubscribe-Post"),
  ) ?? unsubscribeFromHtml(html)
  return {
    id: String(raw.id), accountId: account.id, provider: "gmail", threadId: String(raw.threadId ?? ""), historyId: String(raw.historyId ?? ""),
    labelIds: Array.isArray(raw.labelIds) ? raw.labelIds.map(String) : [], from: header(raw?.payload, "From") || "未知发件人", to: header(raw?.payload, "To"),
    subject, preview: body.slice(0, 120), body: body || "此邮件没有可显示的正文。", html: html || undefined,
    date: internalDate ? new Date(internalDate).toISOString() : new Date().toISOString(), unread: Array.isArray(raw.labelIds) && raw.labelIds.includes("UNREAD"),
    verificationCode: verificationCode(subject, body), attachments: parts.attachments,
    unsubscribeUrl: unsubscribe?.url, unsubscribeOneClick: unsubscribe?.oneClick,
  }
}

export async function fetchGmailMessagesPage(account: MailAccount, pageToken?: string, newestKnownId?: string): Promise<{ messages: MailMessage[]; nextPageToken?: string }> {
  const query = new URLSearchParams({ maxResults: "10", labelIds: "INBOX" })
  if (pageToken) query.set("pageToken", pageToken)
  const listing = await gmailJSON(account, `/messages?${query.toString()}`)
  const listedReferences = Array.isArray(listing?.messages) ? listing.messages : []
  const knownIndex = !pageToken && newestKnownId
    ? listedReferences.findIndex((item: any) => String(item.id) === newestKnownId)
    : -1
  const references = knownIndex >= 0 ? listedReferences.slice(0, knownIndex) : listedReferences
  const details = await Promise.all(references.map((item: any) => gmailJSON(account, `/messages/${encodeURIComponent(String(item.id))}?format=full`)))
  const messages = details.map(item => normalizeGmailMessage(item, account))
  const historyId = messages[0]?.historyId
  if (historyId && historyId !== account.gmailHistoryId) {
    const accounts = loadAccounts()
    const index = accounts.findIndex(item => item.id === account.id)
    if (index >= 0) { accounts[index] = { ...accounts[index], gmailHistoryId: historyId }; saveAccounts(accounts) }
  }
  return { messages, nextPageToken: typeof listing?.nextPageToken === "string" ? listing.nextPageToken : undefined }
}

export async function fetchGmailMessages(account: MailAccount): Promise<MailMessage[]> {
  return (await fetchGmailMessagesPage(account)).messages
}

export async function markGmailMessageRead(account: MailAccount, messageId: string) {
  await gmailJSON(account, `/messages/${encodeURIComponent(messageId)}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) })
}

export async function trashGmailMessage(account: MailAccount, messageId: string) {
  await gmailJSON(account, `/messages/${encodeURIComponent(messageId)}/trash`, { method: "POST", body: "{}" })
}
