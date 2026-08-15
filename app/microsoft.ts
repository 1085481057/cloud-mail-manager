import { Script } from "scripting"
import type { MailAccount, MailMessage } from "./models"
import { MICROSOFT_OAUTH, microsoftOAuthConfigured } from "./microsoft-config"
import { loadAccounts, loadSecret, removeAccountMessageSnapshot, saveAccounts, saveSecret } from "./store"

export { microsoftOAuthConfigured } from "./microsoft-config"

type RequestInit = { method?: string; headers?: Record<string, string>; body?: string }
declare function fetch(url: string, init?: RequestInit): Promise<any>

type MicrosoftSecret = { version: 1; credential: OAuthCredential }
const GRAPH = "https://graph.microsoft.com/v1.0"
const CALLBACK_ID = "microsoft-cloud-mail-manager"
const SCOPE = "openid profile email offline_access User.Read Mail.ReadWrite"

function origin() {
  if (!microsoftOAuthConfigured()) throw new Error("Microsoft 365 登录服务尚未配置")
  return MICROSOFT_OAUTH.origin.replace(/\/+$/, "")
}

function randomToken() {
  return Crypto.generateSymmetricKey(256).toBase64String().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function loadMicrosoftSecret(accountId: string): MicrosoftSecret | undefined {
  try {
    const value = JSON.parse(loadSecret(accountId))
    return value?.version === 1 && value?.credential ? value : undefined
  } catch { return undefined }
}

function saveMicrosoftSecret(accountId: string, value?: MicrosoftSecret) {
  saveSecret(accountId, value ? JSON.stringify(value) : "")
}

export function isMicrosoftAuthorized(accountId: string) {
  const saved = loadMicrosoftSecret(accountId)
  return Boolean(saved?.credential?.oauthRefreshToken || saved?.credential?.oauthToken)
}

function oauth() {
  const helper = new OAuth2({
    consumerKey: "relay",
    consumerSecret: MICROSOFT_OAUTH.relayClientSecret,
    authorizeUrl: `${origin()}/oauth/microsoft/authorize`,
    accessTokenUrl: `${origin()}/oauth/microsoft/token`,
    responseType: "code",
    contentType: "application/x-www-form-urlencoded",
  })
  helper.allowMissingStateCheck = false
  return helper
}

function readableError(error: unknown) {
  const value = error as any
  const detail = value?.underlyingMessage || value?.userInfo?.message || value?.errorUserInfo?.message
  const message = String(detail || value?.message || error)
  if (/cancel|denied|access_denied/i.test(message)) return "已取消 Microsoft 365 登录，未添加账号"
  if (/AADSTS65001|consent/i.test(message)) return "此组织要求管理员批准云邮管家"
  if (/AADSTS50020|tenant/i.test(message)) return "此 Microsoft 365 账号不允许登录当前应用"
  if (/network|offline|timed? ?out|fetch/i.test(message)) return "无法连接 Microsoft 365，请检查网络后重试"
  return `Microsoft 365 登录失败：${message}`
}

export async function authorizeMicrosoft(account: MailAccount): Promise<MailAccount> {
  if (!microsoftOAuthConfigured()) throw new Error("此版本尚未开通 Microsoft 365 登录")
  const verifier = randomToken() + randomToken()
  const verifierData = Data.fromString(verifier)
  if (!verifierData) throw new Error("无法生成 Microsoft 365 登录校验参数")
  const challenge = Crypto.sha256(verifierData).toBase64String().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
  let credential: OAuthCredential
  try {
    credential = await oauth().authorize({
      callbackURL: Script.createOAuthCallbackURLScheme(CALLBACK_ID),
      scope: SCOPE,
      state: randomToken(),
      codeVerifier: verifier,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      parameters: { prompt: "consent" },
    })
  } catch (error) { throw new Error(readableError(error)) }
  if (!credential.oauthToken || !credential.oauthRefreshToken) throw new Error("Microsoft 365 未返回完整授权令牌")
  let credentialAccountId = account.id
  saveMicrosoftSecret(credentialAccountId, { version: 1, credential })
  try {
    const profile = await graphJSON(account, "/me?$select=displayName,mail,userPrincipalName")
    const address = String(profile?.mail || profile?.userPrincipalName || "").trim()
    if (!address) throw new Error("Microsoft 365 未返回邮箱地址")
    const accounts = loadAccounts()
    const existing = accounts.find(item => item.provider === "microsoft" && item.id !== account.id && item.address.toLowerCase() === address.toLowerCase())
    const updated: MailAccount = { ...(existing ?? account), provider: "microsoft", name: existing?.name || String(profile?.displayName || "Microsoft 365"), address, enabled: true, syncState: undefined }
    if (existing) {
      saveMicrosoftSecret(existing.id, { version: 1, credential })
      saveMicrosoftSecret(account.id)
      credentialAccountId = existing.id
    }
    await fetchMicrosoftMessagesPage(updated)
    const index = accounts.findIndex(item => item.id === updated.id)
    if (index >= 0) accounts[index] = updated
    else accounts.push(updated)
    saveAccounts(accounts)
    removeAccountMessageSnapshot(updated.id)
    return updated
  } catch (error) {
    saveMicrosoftSecret(credentialAccountId)
    throw new Error(`Microsoft 365 已授权，但读取邮箱失败：${String((error as any)?.message ?? error)}`)
  }
}

export function disconnectMicrosoft(accountId: string) {
  saveMicrosoftSecret(accountId)
  removeAccountMessageSnapshot(accountId)
  const accounts = loadAccounts()
  const index = accounts.findIndex(item => item.id === accountId)
  if (index >= 0) {
    accounts[index] = { ...accounts[index], syncState: undefined }
    saveAccounts(accounts)
  }
}

async function accessToken(account: MailAccount, force = false) {
  const saved = loadMicrosoftSecret(account.id)
  if (!saved?.credential) throw new Error("请先连接 Microsoft 365 账号")
  const expiresAt = saved.credential.oauthTokenExpiresAt ?? 0
  if (!force && saved.credential.oauthToken && (!expiresAt || expiresAt > Date.now() + 60_000)) return saved.credential.oauthToken
  const refreshToken = saved.credential.oauthRefreshToken
  if (!refreshToken) throw new Error("Microsoft 365 授权已失效，请重新连接")
  const response = await fetch(`${origin()}/oauth/microsoft/token`, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPE, client_id: "relay", client_secret: MICROSOFT_OAUTH.relayClientSecret }).toString(),
  })
  const payload = await response.json()
  if (!response.ok || !payload?.access_token) {
    const message = String(payload?.error_description || payload?.error || `HTTP ${response.status}`)
    if (/invalid_grant|revoked/i.test(message)) saveMicrosoftSecret(account.id)
    throw new Error(/invalid_grant|revoked/i.test(message) ? "Microsoft 365 授权已撤销，请重新连接" : `Microsoft 365 令牌刷新失败：${message}`)
  }
  const credential: OAuthCredential = { ...saved.credential, oauthToken: String(payload.access_token), oauthRefreshToken: String(payload.refresh_token || refreshToken), oauthTokenExpiresAt: payload.expires_in ? Date.now() + Number(payload.expires_in) * 1000 : saved.credential.oauthTokenExpiresAt }
  saveMicrosoftSecret(account.id, { version: 1, credential })
  return credential.oauthToken
}

function wait(milliseconds: number) {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds))
}

async function graphJSON(account: MailAccount, pathOrURL: string, init: RequestInit = {}, retryCount = 0): Promise<any> {
  const token = await accessToken(account, retryCount > 0)
  const url = /^https:\/\//i.test(pathOrURL) ? pathOrURL : `${GRAPH}${pathOrURL}`
  const parsedURL = new URL(url)
  if (parsedURL.protocol !== "https:" || parsedURL.hostname !== "graph.microsoft.com" || !parsedURL.pathname.startsWith("/v1.0/")) throw new Error("Microsoft 365 分页状态无效，请刷新收件箱")
  const response = await fetch(url, { ...init, headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } })
  if (response.status === 401 && retryCount === 0) return graphJSON(account, pathOrURL, init, 1)
  if ((response.status === 429 || response.status === 503 || response.status === 504) && retryCount < 2) {
    const retryAfter = Number(response.headers?.get?.("retry-after") ?? 0)
    await wait(Math.min(Math.max(retryAfter * 1000 || 800 * (retryCount + 1), 500), 5000))
    return graphJSON(account, pathOrURL, init, retryCount + 1)
  }
  const payload = await response.json()
  if (!response.ok) {
    if (response.status === 429) throw new Error("Microsoft 365 请求过于频繁，请稍后重试")
    const graphCode = String(payload?.error?.code || "").trim()
    const graphMessage = String(payload?.error?.message || "").trim()
    const detail = [graphCode, graphMessage].filter(Boolean).join(": ")
    throw new Error(detail || `Microsoft Graph 请求失败（HTTP ${response.status}）`)
  }
  return payload
}

function stripHtml(value: string) {
  return value.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/[ \t]+/g, " ").trim()
}

function normalize(raw: any, account: MailAccount): MailMessage {
  const html = raw?.body?.contentType === "html" ? String(raw?.body?.content || "") : ""
  const body = raw?.body?.contentType === "text" ? String(raw?.body?.content || "") : stripHtml(html) || String(raw?.bodyPreview || "")
  const from = raw?.from?.emailAddress
  return {
    id: String(raw.id), accountId: account.id, provider: "microsoft", from: from?.name ? `${from.name} <${from.address}>` : String(from?.address || "未知发件人"),
    to: Array.isArray(raw?.toRecipients) ? raw.toRecipients.map((item: any) => item?.emailAddress?.address).filter(Boolean).join(", ") : undefined,
    subject: String(raw?.subject || "（无主题）"), preview: String(raw?.bodyPreview || body).slice(0, 120), body: body || "此邮件没有可显示的正文。", html: html || undefined,
    date: String(raw?.receivedDateTime || new Date().toISOString()), unread: !Boolean(raw?.isRead), attachments: [],
  }
}

export async function fetchMicrosoftMessagesPage(account: MailAccount, cursor?: string): Promise<{ messages: MailMessage[]; nextCursor?: string }> {
  const path = cursor || "/me/mailFolders/inbox/messages?$top=10&$orderby=receivedDateTime%20desc&$select=id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,body,hasAttachments"
  const payload = await graphJSON(account, path, { headers: { Prefer: 'outlook.body-content-type="html"' } })
  return { messages: Array.isArray(payload?.value) ? payload.value.map((item: any) => normalize(item, account)) : [], nextCursor: typeof payload?.["@odata.nextLink"] === "string" ? payload["@odata.nextLink"] : undefined }
}

export async function markMicrosoftMessageRead(account: MailAccount, messageId: string) {
  await graphJSON(account, `/me/messages/${encodeURIComponent(messageId)}`, { method: "PATCH", body: JSON.stringify({ isRead: true }) })
}

export async function deleteMicrosoftMessage(account: MailAccount, messageId: string) {
  await graphJSON(account, `/me/messages/${encodeURIComponent(messageId)}/move`, { method: "POST", body: JSON.stringify({ destinationId: "deleteditems" }) })
}
