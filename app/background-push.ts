import type { MailAccount, MailMessage } from "./models"
import { GMAIL_OAUTH_RELAY } from "./gmail-config"
import { loadSecret } from "./store"

declare function fetch(url: string, init?: any): Promise<any>

const CONFIGURED_KEY = "cloud_mail_manager.background_push_configured.v2"
const PUSH_KEYCHAIN_KEY = "cloud_mail_manager.remote_push_subscription_key.v1"
const ADMIN_TOKEN_KEYCHAIN_KEY = "cloud_mail_manager.background_push_admin_token.v1"

export type BackgroundPushStatus = {
  enabled: boolean
  accountCount: number
  accounts?: Array<{ id: string; provider: string; active: boolean; lastCheckedAt?: string }>
}

function origin() {
  const value = GMAIL_OAUTH_RELAY.origin.trim().replace(/\/+$/, "")
  if (!/^https:\/\//i.test(value)) throw new Error("后台推送服务尚未配置")
  return value
}

function refreshToken(account: MailAccount) {
  try {
    const saved = JSON.parse(loadSecret(account.id))
    const value = saved?.credential?.oauthRefreshToken
    return typeof value === "string" ? value : ""
  } catch { return "" }
}

function newestId(account: MailAccount, messages: MailMessage[]) {
  return messages.find(message => message.accountId === account.id)?.id ?? ""
}

function supportedAccounts(accounts: MailAccount[], messages: MailMessage[]) {
  return accounts
    .filter(account => account.enabled && (account.provider === "gmail" || account.provider === "microsoft"))
    .map(account => ({ id: account.id, provider: account.provider, address: account.address, refreshToken: refreshToken(account), newestId: newestId(account, messages) }))
    .filter(account => account.refreshToken && account.address)
}

function adminToken() {
  return String(Keychain.get(ADMIN_TOKEN_KEYCHAIN_KEY) ?? "").trim()
}

export function loadBackgroundPushAdminToken() {
  return adminToken()
}

export function saveBackgroundPushAdminToken(value: string) {
  const token = value.trim()
  if (token && token.length < 32) throw new Error("后台推送所有者令牌格式无效")
  if (token) Keychain.set(ADMIN_TOKEN_KEYCHAIN_KEY, token)
  else Keychain.remove(ADMIN_TOKEN_KEYCHAIN_KEY)
}

async function request(path: string, init: any = {}) {
  const token = adminToken()
  if (!token) throw new Error("请先填写后台推送所有者令牌")
  const response = await fetch(`${origin()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  })
  let payload: any = {}
  try { payload = await response.json() } catch {}
  if (!response.ok || payload?.error) throw new Error(String(payload?.error?.message ?? `后台推送服务请求失败（HTTP ${response.status}）`))
  return payload?.data ?? payload
}

export function hasBackgroundPushConfiguration() {
  return Boolean(Storage.get(CONFIGURED_KEY))
}

export async function configureBackgroundPush(accounts: MailAccount[], messages: MailMessage[]) {
  const pushKey = Keychain.get(PUSH_KEYCHAIN_KEY)
  if (!pushKey) throw new Error("请先绑定 Remote Push Subscription Key")
  const delegatedAccounts = supportedAccounts(accounts, messages)
  if (!delegatedAccounts.length) throw new Error("当前没有可用于后台推送的 Gmail 或 Microsoft 365 账号")
  const data = await request("/v1/push/config", {
    method: "PUT",
    body: JSON.stringify({ pushKey, accounts: delegatedAccounts }),
  }) as BackgroundPushStatus
  Storage.set(CONFIGURED_KEY, { enabled: true, accountIds: delegatedAccounts.map(account => account.id), updatedAt: new Date().toISOString() })
  return data
}

export async function loadBackgroundPushStatus(): Promise<BackgroundPushStatus> {
  if (!adminToken()) return { enabled: false, accountCount: 0 }
  return request("/v1/push/config", { method: "GET" })
}

export async function clearBackgroundPush() {
  await request("/v1/push/config", { method: "DELETE", body: JSON.stringify({}) })
  Storage.remove(CONFIGURED_KEY)
}
