import type { MailAccount, MailMessage, Provider } from "./models"
import { providerName } from "./models"
import { extractVerificationCode } from "./verification"

const ACCOUNTS_KEY = "cloud_mail_manager.accounts.v1"
const SECRET_PREFIX = "cloud_mail_manager.secret."
const MESSAGE_SNAPSHOT_KEY = "cloud_mail_manager.messages.v3"
const SNAPSHOT_TZ_FIX_KEY = "cloud_mail_manager.snapshot_tz_fix.v3"
const GMAIL_PAGINATION_KEY = "cloud_mail_manager.gmail_pagination.v1"
const SNAPSHOT_LIMIT = 100
const MESSAGE_CONTENT_DIRECTORY = "cloud-mail-manager-message-content-v1"
const ICLOUD_BACKUP_DIRECTORY = "CloudMailManager"
const ICLOUD_ACCOUNTS_FILE = "accounts.v1.json"

export type ICloudAccountBackupStatus = {
  available: boolean
  backupExists: boolean
  accountCount: number
  updatedAt?: string
}

type ICloudAccountBackup = {
  version: 1
  updatedAt: string
  accounts: MailAccount[]
}

function iCloudAccountsPath() {
  return `${FileManager.iCloudDocumentsDirectory}/${ICLOUD_BACKUP_DIRECTORY}/${ICLOUD_ACCOUNTS_FILE}`
}

function validBackup(value: unknown): value is ICloudAccountBackup {
  if (!value || typeof value !== "object") return false
  const backup = value as ICloudAccountBackup
  return backup.version === 1 && typeof backup.updatedAt === "string" && Array.isArray(backup.accounts)
}

async function readICloudBackup(): Promise<ICloudAccountBackup | null> {
  if (!FileManager.isiCloudEnabled) return null
  const path = iCloudAccountsPath()
  if (!await FileManager.exists(path)) return null
  if (FileManager.isFileStoredIniCloud(path) && !FileManager.isiCloudFileDownloaded(path)) {
    const downloaded = await FileManager.downloadFileFromiCloud(path)
    if (!downloaded) throw new Error("iCloud 账号备份下载失败")
  }
  const value = JSON.parse(await FileManager.readAsString(path)) as unknown
  if (!validBackup(value)) throw new Error("iCloud 账号备份格式无效")
  return value
}

export async function getICloudAccountBackupStatus(): Promise<ICloudAccountBackupStatus> {
  if (!FileManager.isiCloudEnabled) return { available: false, backupExists: false, accountCount: 0 }
  const backup = await readICloudBackup()
  return {
    available: true,
    backupExists: Boolean(backup),
    accountCount: backup?.accounts.length ?? 0,
    updatedAt: backup?.updatedAt,
  }
}

export async function syncAccountsToICloud(accounts = loadAccounts()): Promise<ICloudAccountBackupStatus> {
  if (!FileManager.isiCloudEnabled) throw new Error("iCloud Drive 未启用或未授权 Scripting 使用")
  const directory = `${FileManager.iCloudDocumentsDirectory}/${ICLOUD_BACKUP_DIRECTORY}`
  await FileManager.createDirectory(directory, true)
  const backup: ICloudAccountBackup = {
    version: 1,
    updatedAt: new Date().toISOString(),
    accounts,
  }
  await FileManager.writeAsString(iCloudAccountsPath(), JSON.stringify(backup))
  return { available: true, backupExists: true, accountCount: accounts.length, updatedAt: backup.updatedAt }
}

export async function restoreAccountsFromICloud(onlyWhenLocalEmpty = false): Promise<MailAccount[]> {
  const local = loadAccounts()
  if (onlyWhenLocalEmpty && local.length) return local
  const backup = await readICloudBackup()
  if (!backup?.accounts.length) return local
  saveAccounts(backup.accounts)
  return backup.accounts
}

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
  Keychain.remove(SECRET_PREFIX + accountId)
  if (secret.trim()) Keychain.set(SECRET_PREFIX + accountId, secret.trim(), { accessibility: "first_unlock_this_device" })
}

export function loadSecret(accountId: string) {
  return Keychain.get(SECRET_PREFIX + accountId) ?? ""
}

function messageContentDirectory() {
  return `${FileManager.appGroupDocumentsDirectory}/${MESSAGE_CONTENT_DIRECTORY}`
}

function messageContentPath(accountId: string, messageId: string) {
  const key = `${accountId}:${messageId}`
  const encoded = Data.fromString(key)?.toBase64String().replace(/[+/=]/g, "_") ?? key.replace(/[^A-Za-z0-9._-]/g, "_")
  return `${messageContentDirectory()}/${encoded}.json`
}

export function loadMessageSnapshot(): MailMessage[] {
  try {
    const value = Storage.get(MESSAGE_SNAPSHOT_KEY)
    if (!Array.isArray(value)) return []
    let modified = false
    const validMessages = value.filter(msg => !msg.isPlaceholder)
    if (validMessages.length !== value.length) modified = true
    const tzFixApplied = Boolean(Storage.get(SNAPSHOT_TZ_FIX_KEY))
    const sanitized = validMessages.map(msg => {
      let updatedMsg = msg
      if (!tzFixApplied && updatedMsg.provider === "cloudmail" && typeof updatedMsg.date === "string") {
        const ts = Date.parse(updatedMsg.date)
        if (Number.isFinite(ts) && ts > 0) {
          updatedMsg = { ...updatedMsg, date: new Date(ts + 8 * 3600 * 1000).toISOString() }
          modified = true
        }
      }
      if (updatedMsg.contentCached) {
        try {
          const content = JSON.parse(FileManager.readAsStringSync(messageContentPath(updatedMsg.accountId, updatedMsg.id))) as Partial<MailMessage>
          const body = content.body ?? updatedMsg.body
          const code = extractVerificationCode(updatedMsg.subject, body)
          const newCode = code !== undefined ? code : (updatedMsg.provider === "cloudmail" ? updatedMsg.verificationCode : undefined)
          if (newCode !== updatedMsg.verificationCode) {
            modified = true
            updatedMsg = { ...updatedMsg, verificationCode: newCode }
          }
        } catch {}
      }
      return updatedMsg
    })
    if (!tzFixApplied) {
      Storage.set(SNAPSHOT_TZ_FIX_KEY, true)
      modified = true
    }
    if (modified) {
      Storage.set(MESSAGE_SNAPSHOT_KEY, sanitized)
    }
    return sanitized
  } catch {
    return []
  }
}

export function isMessageContentFull(message?: MailMessage | null): boolean {
  if (!message || message.isPlaceholder) return false
  if (typeof message.html === "string" && message.html.trim().length > 0) return true
  if (typeof message.body === "string" && message.body.trim().length > 0 && !message.body.includes("正在加载邮件完整内容")) {
    return true
  }
  return false
}

export function loadMessageContent(message: MailMessage): MailMessage {
  if (!message) return message
  // 若内存中已有有效完整 html 且不是占位符，无需重复读取文件
  if (!message.isPlaceholder && typeof message.html === "string" && message.html.trim().length > 0) {
    return message
  }
  try {
    const filePath = messageContentPath(message.accountId, message.id)
    const raw = FileManager.readAsStringSync(filePath)
    if (raw) {
      const value = JSON.parse(raw) as Partial<MailMessage>
      const body = value.body ?? message.body
      const html = value.html ?? message.html
      const attachments = value.attachments ?? message.attachments
      const code = extractVerificationCode(message.subject, body)
      const verificationCode = code !== undefined ? code : (message.provider === "cloudmail" ? message.verificationCode : undefined)
      const hasFull = Boolean((html && html.trim().length > 0) || (body && body.trim().length > 0 && !body.includes("正在加载邮件完整内容")))
      return {
        ...message,
        body,
        html,
        attachments,
        contentCached: true,
        verificationCode,
        isPlaceholder: hasFull ? false : message.isPlaceholder,
      }
    }
  } catch {}
  return message
}

export function saveMessageContent(message: MailMessage) {
  if (!message.html && !message.body && !(message.attachments?.length)) return false
  try {
    FileManager.createDirectorySync(messageContentDirectory(), true)
    FileManager.writeAsStringSync(messageContentPath(message.accountId, message.id), JSON.stringify({
      body: message.body,
      html: message.html,
      attachments: message.attachments,
    }))
    return true
  } catch (error) {
    console.warn("邮件正文缓存失败", error)
    return false
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
  const removed = loadMessageSnapshot().filter(message => message.accountId === accountId)
  const remaining = loadMessageSnapshot().filter(message => message.accountId !== accountId)
  for (const message of removed) {
    try { FileManager.removeSync(messageContentPath(message.accountId, message.id)) } catch {}
  }
  saveMessageSnapshot(remaining)
}

export function saveMessageSnapshot(messages: MailMessage[]) {
  try {
    const snapshot = messages.slice(0, SNAPSHOT_LIMIT).map(message => {
      const contentCached = message.contentCached ? true : saveMessageContent(message)
      return {
        ...message,
        body: message.preview || message.body.slice(0, 240),
        html: undefined,
        attachments: undefined,
        contentCached,
      }
    })
    Storage.set(MESSAGE_SNAPSHOT_KEY, snapshot)
  } catch (error) {
    console.warn("邮件快照保存失败", error)
  }
}

export function removeAccount(account: MailAccount) {
  removeAccountMessageSnapshot(account.id)
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
