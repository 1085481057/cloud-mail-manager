import type { MailAccount, MailMessage, Provider } from "./models"
import { providerName } from "./models"

const ACCOUNTS_KEY = "cloud_mail_manager.accounts.v1"
const SECRET_PREFIX = "cloud_mail_manager.secret."
const MESSAGE_SNAPSHOT_KEY = "cloud_mail_manager.messages.v1"
const GMAIL_PAGINATION_KEY = "cloud_mail_manager.gmail_pagination.v1"
const SNAPSHOT_LIMIT = 100
const SNAPSHOT_BUDGET = 1_500_000

export function loadAccounts(): MailAccount[] {
  try {
    const value = Storage.get(ACCOUNTS_KEY)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function saveAccounts(accounts: MailAccount[]) {
  Storage.set(ACCOUNTS_KEY, accounts)
}

export function saveSecret(accountId: string, secret: string) {
  if (secret.trim()) Keychain.set(SECRET_PREFIX + accountId, secret.trim(), { accessibility: "unlocked_this_device" })
  else Keychain.remove(SECRET_PREFIX + accountId)
}

export function loadSecret(accountId: string) {
  return Keychain.get(SECRET_PREFIX + accountId) ?? ""
}

export function loadMessageSnapshot(): MailMessage[] {
  try {
    const value = Storage.get(MESSAGE_SNAPSHOT_KEY)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export type GmailPaginationState = {
  token?: string
  started: boolean
}

export function loadGmailPagination(accountId: string): GmailPaginationState {
  try {
    const value = Storage.get(GMAIL_PAGINATION_KEY) as Record<string, GmailPaginationState> | undefined
    const state = value?.[accountId]
    return state && typeof state.started === "boolean" ? state : { started: false }
  } catch {
    return { started: false }
  }
}

export function saveGmailPagination(accountId: string, state: GmailPaginationState) {
  try {
    const value = (Storage.get(GMAIL_PAGINATION_KEY) as Record<string, GmailPaginationState> | undefined) ?? {}
    value[accountId] = state
    Storage.set(GMAIL_PAGINATION_KEY, value)
  } catch (error) {
    console.warn("Gmail 分页游标保存失败", error)
  }
}

export function removeAccountMessageSnapshot(accountId: string) {
  const remaining = loadMessageSnapshot().filter(message => message.accountId !== accountId)
  saveMessageSnapshot(remaining)
}

export function saveMessageSnapshot(messages: MailMessage[]) {
  try {
    const snapshot: MailMessage[] = []
    let used = 0
    for (const message of messages.slice(0, SNAPSHOT_LIMIT)) {
      const compact: MailMessage = {
        ...message,
        body: message.body.slice(0, 40_000),
        html: message.html,
      }
      let size = JSON.stringify(compact).length
      if (used + size > SNAPSHOT_BUDGET) {
        compact.html = undefined
        compact.body = message.body.slice(0, 4_000)
        size = JSON.stringify(compact).length
      }
      if (used + size > SNAPSHOT_BUDGET) {
        compact.body = message.body.slice(0, 800)
        compact.attachments = undefined
        size = JSON.stringify(compact).length
      }
      if (used + size > SNAPSHOT_BUDGET) continue
      snapshot.push(compact)
      used += size
    }
    Storage.set(MESSAGE_SNAPSHOT_KEY, snapshot)
  } catch (error) {
    console.warn("邮件快照保存失败", error)
  }
}

export function removeAccount(account: MailAccount) {
  saveAccounts(loadAccounts().filter(item => item.id !== account.id))
  Keychain.remove(SECRET_PREFIX + account.id)
}

export function makeAccount(provider: Provider): MailAccount {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return {
    id: `${provider}-${suffix}`,
    provider,
    name: providerName(provider),
    address: "",
    baseUrl: "",
    inboxPath: "/api/email/list",
    allReceive: 0,
    enabled: true,
  }
}

export const demoMessages: MailMessage[] = [
  {
    id: "demo-1",
    accountId: "demo-cloudmail",
    provider: "cloudmail",
    from: "Cloud Mail <system@example.com>",
    to: "demo@example.com",
    subject: "欢迎使用云邮管家",
    preview: "Cloud Mail、Gmail 和 QQ 邮箱将在这里汇总展示。",
    body: "这是演示邮件。添加 Cloud Mail 账号并填写接口地址后，下拉刷新即可读取真实邮件。\n\n点击“查看原邮件”可以保留排版并打开邮件中的链接。",
    html: '<h2>欢迎使用云邮管家</h2><p>点击“查看原邮件”可以保留排版，并打开邮件中的验证链接。</p><p><a href="https://example.com/verify">演示验证链接</a></p>',
    date: new Date().toISOString(),
    unread: true,
  },
  {
    id: "demo-2",
    accountId: "demo-gmail",
    provider: "gmail",
    from: "Google",
    subject: "Gmail 接入准备",
    preview: "配置 Google OAuth 客户端后即可启用 Gmail API。",
    body: "云邮管家已经保留 Gmail 账号入口。生产接入时使用 OAuth 2.0 PKCE，不保存 Google 密码。",
    date: new Date(Date.now() - 3600_000).toISOString(),
    unread: false,
  },
]
