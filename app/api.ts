import type { CloudMailRemoteAccount, CloudMailWebsiteConfig, MailAccount, MailAttachment, MailMessage } from "./models"
import { loadSecret, saveAccounts, saveSecret, loadAccounts, loadGmailPagination, saveGmailPagination, removeAccountMessageSnapshot } from "./store"
import { fetchGmailMessagesPage, markGmailMessageRead, trashGmailMessage } from "./gmail"
import { unsubscribeFromHtml } from "./unsubscribe"
import { deleteImapMessage, fetchImapMessagesPage, markImapMessageRead } from "./imap"
import { deleteMicrosoftMessage, fetchMicrosoftMessagesPage, markMicrosoftMessageRead } from "./microsoft"

type RequestInit = { method?: string; headers?: Record<string, string>; body?: string }
declare function fetch(url: string, init?: RequestInit): Promise<any>

type Envelope = { code?: number; message?: string; data?: any }

const gmailNextPageTokens = new Map<string, string | undefined>()
const gmailPaginationStarted = new Set<string>()

function gmailPagination(accountId: string) {
  if (!gmailPaginationStarted.has(accountId)) {
    const state = loadGmailPagination(accountId)
    if (state.started) {
      gmailPaginationStarted.add(accountId)
      gmailNextPageTokens.set(accountId, state.token)
    }
  }
}

function baseUrl(account: MailAccount) {
  return (account.baseUrl ?? "").trim().replace(/\/+$/, "")
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? _
    const codePoint = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    try { return String.fromCodePoint(codePoint) } catch { return _ }
  })
}

function stripHtml(value: string) {
  return decodeHtmlEntities(value
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function extractVerificationCode(subject: string, body: string, serverCode: string) {
  const source = `${subject}\n${body}`
  const keyword = /(?:验证码|校验码|动态码|登录码|安全码|一次性密码|verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP)/i
  if (!keyword.test(source)) return undefined

  const escaped = serverCode.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (escaped && new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:[^A-Z0-9]|$)`, "i").test(source)) return serverCode.trim()

  const nearbyPatterns = [
    /(?:验证码|校验码|动态码|登录码|安全码|一次性密码)[^A-Z0-9]{0,20}([A-Z0-9]{4,8})/i,
    /(?:verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP)[^A-Z0-9]{0,24}([A-Z0-9]{4,8})/i,
    /([A-Z0-9]{4,8})[^A-Z0-9]{0,20}(?:是.{0,4}(?:验证码|校验码|动态码)|is your (?:verification|security|login) code)/i,
  ]
  for (const pattern of nearbyPatterns) {
    const candidate = source.match(pattern)?.[1]
    if (candidate && /\d/.test(candidate)) return candidate
  }
  return undefined
}

function parseRecipient(raw: unknown) {
  if (typeof raw !== "string") return ""
  try {
    const list = JSON.parse(raw)
    if (Array.isArray(list)) return list.map(item => item?.address ?? item?.name ?? "").filter(Boolean).join(", ")
  } catch {}
  return raw
}

async function request(account: MailAccount, path: string, init: RequestInit = {}, authenticated = true) {
  const token = loadSecret(account.id)
  const response = await fetch(`${baseUrl(account)}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Accept-Language": "zh-CN",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(authenticated && token ? { Authorization: token } : {}),
      ...(init.headers ?? {}),
    },
  })
  const rawText = await response.text()
  let payload: Envelope
  try { payload = JSON.parse(rawText) }
  catch { throw new Error(`接口未返回 JSON（HTTP ${response.status ?? "未知"}）`) }
  if (!response.ok) throw new Error(payload.message ?? `请求失败（HTTP ${response.status}）`)
  if (payload.code !== 200) {
    if (payload.code === 401) saveSecret(account.id, "")
    throw new Error(payload.code === 401 ? "登录已过期，请编辑账号重新登录" : payload.message ?? `Cloud Mail 错误 ${payload.code}`)
  }
  return payload.data
}

function toOssDomain(domain: string) {
  if (!domain) return ""
  const value = domain.startsWith("http") ? domain : `https://${domain}`
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function cloudMailResourceUrl(key: string, r2Domain: string) {
  if (!key) return ""
  if (key.startsWith("https://")) return key
  const domain = toOssDomain(r2Domain)
  return domain ? `${domain}/${key}` : key
}

function normalizeAttachment(raw: any, r2Domain: string): MailAttachment {
  const key = text(raw.key)
  return {
    id: String(raw.attId ?? raw.id ?? raw.key),
    filename: text(raw.filename, "附件"),
    mimeType: text(raw.mimeType, "application/octet-stream"),
    size: Number(raw.size ?? 0),
    key,
    url: cloudMailResourceUrl(key, r2Domain),
  }
}

function normalizeMessage(raw: any, account: MailAccount, index: number, r2Domain: string): MailMessage {
  const plainBody = text(raw.text)
  const resourceDomain = toOssDomain(r2Domain)
  const html = text(raw.content).replace(/{{domain}}/g, `${resourceDomain}/`)
  const body = plainBody || stripHtml(html)
  const subject = text(raw.subject, "（无主题）")
  const unsubscribe = unsubscribeFromHtml(html)
  return {
    id: String(raw.emailId ?? `${account.id}-${index}`),
    accountId: account.id,
    provider: "cloudmail",
    from: [text(raw.name), text(raw.sendEmail)].filter(Boolean).join(" <") + (raw.name && raw.sendEmail ? ">" : "") || "未知发件人",
    to: text(raw.toEmail) || parseRecipient(raw.recipient),
    subject,
    preview: body.slice(0, 120),
    body: body || "此邮件只有 HTML 正文，请在 Cloud Mail 网页端查看。",
    html,
    date: text(raw.createTime, new Date().toISOString()),
    unread: Number(raw.unread) === 0,
    verificationCode: extractVerificationCode(subject, body, text(raw.code)),
    attachments: Array.isArray(raw.attList) ? raw.attList.map((item: any) => normalizeAttachment(item, r2Domain)) : [],
    unsubscribeUrl: unsubscribe?.url, unsubscribeOneClick: unsubscribe?.oneClick,
  }
}

export async function loginCloudMail(account: MailAccount, password: string): Promise<MailAccount> {
  if (!baseUrl(account)) throw new Error("请填写 Cloud Mail 部署地址")
  if (!account.address.trim() || !password) throw new Error("请填写登录邮箱和密码")
  const data = await request(account, "/api/login", {
    method: "POST",
    body: JSON.stringify({ email: account.address.trim(), password }),
  }, false)
  if (!data?.token) throw new Error("登录成功但服务端没有返回 Token")
  saveSecret(account.id, String(data.token))

  const [info, websiteConfig] = await Promise.all([
    request(account, "/api/my/loginUserInfo"),
    fetchCloudMailWebsiteConfig(account).catch(() => undefined),
  ])
  const updated: MailAccount = {
    ...account,
    address: text(info?.email, account.address),
    name: account.name.trim() || text(info?.name, "Cloud Mail"),
    remoteAccountId: Number(info?.account?.accountId ?? 0) || undefined,
    allReceive: Number(info?.account?.allReceive ?? 0),
    r2Domain: websiteConfig?.r2Domain ?? account.r2Domain,
    inboxPath: "/api/email/list",
  }
  const accounts = loadAccounts()
  const index = accounts.findIndex(item => item.id === updated.id)
  if (index >= 0) accounts[index] = updated
  else accounts.push(updated)
  saveAccounts(accounts)
  return updated
}

function normalizeRemoteAccount(raw: any): CloudMailRemoteAccount {
  return {
    accountId: Number(raw.accountId),
    email: text(raw.email),
    name: text(raw.name),
    status: Number(raw.status ?? 0),
    latestEmailTime: raw.latestEmailTime ?? null,
    createTime: raw.createTime ?? null,
    allReceive: Number(raw.allReceive ?? 0),
    sort: Number(raw.sort ?? 0),
  }
}

export async function fetchCloudMailAccounts(account: MailAccount): Promise<CloudMailRemoteAccount[]> {
  const all: CloudMailRemoteAccount[] = []
  let accountId = 0
  let lastSort = 9999999999
  for (let page = 0; page < 20; page++) {
    const data = await request(account, `/api/account/list?accountId=${accountId}&size=30&lastSort=${lastSort}`)
    if (!Array.isArray(data)) throw new Error("Cloud Mail 账号列表格式异常")
    const batch = data.map(normalizeRemoteAccount)
    all.push(...batch)
    if (batch.length < 30) break
    const last = batch[batch.length - 1]
    accountId = last.accountId
    lastSort = last.sort
  }
  return all
}

export async function fetchCloudMailWebsiteConfig(account: MailAccount): Promise<CloudMailWebsiteConfig> {
  const data = await request(account, "/api/setting/websiteConfig")
  return {
    domainList: Array.isArray(data?.domainList) ? data.domainList.map(String) : [],
    addVerifyOpen: Boolean(data?.addVerifyOpen),
    addEmailVerify: Number(data?.addEmailVerify ?? 0),
    r2Domain: text(data?.r2Domain),
  }
}

export async function createCloudMailAccount(account: MailAccount, email: string) {
  const data = await request(account, "/api/account/add", { method: "POST", body: JSON.stringify({ email: email.trim(), token: "" }) })
  return normalizeRemoteAccount(data)
}

export async function renameCloudMailAccount(account: MailAccount, remoteAccountId: number, name: string) {
  await request(account, "/api/account/setName", { method: "PUT", body: JSON.stringify({ accountId: remoteAccountId, name: name.trim() }) })
}

export async function setCloudMailAllReceive(account: MailAccount, remoteAccountId: number) {
  await request(account, "/api/account/setAllReceive", { method: "PUT", body: JSON.stringify({ accountId: remoteAccountId }) })
}

export async function pinCloudMailAccount(account: MailAccount, remoteAccountId: number) {
  await request(account, "/api/account/setAsTop", { method: "PUT", body: JSON.stringify({ accountId: remoteAccountId }) })
}

export async function deleteCloudMailAccount(account: MailAccount, remoteAccountId: number) {
  await request(account, `/api/account/delete?accountId=${remoteAccountId}`, { method: "DELETE" })
}

export async function fetchOlderAccountMessages(account: MailAccount, oldest?: MailMessage): Promise<{ messages: MailMessage[]; hasMore: boolean }> {
  if (!account.enabled) return { messages: [], hasMore: false }
  if (account.provider === "gmail") {
    gmailPagination(account.id)
    const token = gmailNextPageTokens.get(account.id)
    if (gmailPaginationStarted.has(account.id) && !token) return { messages: [], hasMore: false }
    const page = await fetchGmailMessagesPage(account, token)
    gmailPaginationStarted.add(account.id)
    gmailNextPageTokens.set(account.id, page.nextPageToken)
    saveGmailPagination(account.id, { started: true, token: page.nextPageToken })
    return { messages: page.messages, hasMore: Boolean(page.nextPageToken) }
  }
  if (account.provider === "microsoft") {
    if (account.syncState?.ended) return { messages: [], hasMore: false }
    const page = await fetchMicrosoftMessagesPage(account, account.syncState?.cursor)
    const accounts = loadAccounts()
    const index = accounts.findIndex(item => item.id === account.id)
    if (index >= 0) { accounts[index] = { ...accounts[index], syncState: { cursor: page.nextCursor, ended: !page.nextCursor } }; saveAccounts(accounts) }
    return { messages: page.messages, hasMore: Boolean(page.nextCursor) }
  }
  if (["qq", "netease163", "netease126", "yeah"].includes(account.provider)) {
    const ended = account.syncState ? Boolean(account.syncState.ended) : Boolean(account.qqPaginationEnded)
    if (ended) return { messages: [], hasMore: false }
    const page = await fetchImapMessagesPage(account, account.syncState?.cursor || account.qqBeforeUID || oldest?.id.split(":").at(-1))
    const accounts = loadAccounts()
    const index = accounts.findIndex(item => item.id === account.id)
    if (index >= 0) {
      accounts[index] = { ...accounts[index], qqBeforeUID: page.nextBeforeUID || account.qqBeforeUID, qqPaginationEnded: !page.hasMore, syncState: { cursor: page.nextBeforeUID, ended: !page.hasMore, uidValidity: page.uidValidity } }
      saveAccounts(accounts)
    }
    return { messages: page.messages, hasMore: page.hasMore }
  }
  if (account.provider !== "cloudmail") throw new Error("此邮箱暂不支持历史分页")
  if (!baseUrl(account) || !loadSecret(account.id) || !account.remoteAccountId) throw new Error("请先完成 Cloud Mail 登录")
  const params = new URLSearchParams({
    accountId: String(account.remoteAccountId), allReceive: String(account.allReceive ?? 0),
    emailId: oldest?.id || "9999999999", timeSort: "0", size: "10", type: "0",
  })
  const data = await request(account, `/api/email/list?${params.toString()}`)
  const list = Array.isArray(data) ? data : data?.list
  if (!Array.isArray(list)) throw new Error("Cloud Mail 邮件列表格式异常")
  const r2Domain = account.r2Domain ?? ""
  const messages = list.map((item: any, index: number) => normalizeMessage(item, account, index, r2Domain))
  return { messages, hasMore: messages.length >= 10 }
}

export async function fetchAccountMessages(account: MailAccount, latestEmailId?: string): Promise<{ messages: MailMessage[]; resetAccount: boolean }> {
  if (!account.enabled) return { messages: [], resetAccount: false }
  if (account.provider === "gmail") {
    gmailPagination(account.id)
    const hadHistoryCursor = gmailPaginationStarted.has(account.id)
    const page = await fetchGmailMessagesPage(account, undefined, latestEmailId)
    if (!hadHistoryCursor) {
      gmailPaginationStarted.add(account.id)
      gmailNextPageTokens.set(account.id, page.nextPageToken)
      saveGmailPagination(account.id, { started: true, token: page.nextPageToken })
    }
    return { messages: page.messages, resetAccount: false }
  }
  if (account.provider === "microsoft") {
    const page = await fetchMicrosoftMessagesPage(account)
    const accounts = loadAccounts()
    const index = accounts.findIndex(item => item.id === account.id)
    if (index >= 0) { accounts[index] = { ...accounts[index], syncState: { cursor: page.nextCursor, ended: !page.nextCursor } }; saveAccounts(accounts) }
    return { messages: page.messages, resetAccount: false }
  }
  if (["qq", "netease163", "netease126", "yeah"].includes(account.provider)) {
    const page = await fetchImapMessagesPage(account)
    const accounts = loadAccounts()
    const index = accounts.findIndex(item => item.id === account.id)
    let mailboxChanged = false
    if (index >= 0) {
      mailboxChanged = Boolean(accounts[index].syncState?.uidValidity && page.uidValidity && accounts[index].syncState?.uidValidity !== page.uidValidity)
      if (mailboxChanged) removeAccountMessageSnapshot(account.id)
      if (mailboxChanged || !accounts[index].syncState?.cursor) {
        accounts[index] = { ...accounts[index], qqBeforeUID: page.nextBeforeUID, qqPaginationEnded: !page.hasMore, syncState: { cursor: page.nextBeforeUID, ended: !page.hasMore, uidValidity: page.uidValidity } }
        saveAccounts(accounts)
      }
    }
    return { messages: page.messages, resetAccount: mailboxChanged }
  }
  if (account.provider !== "cloudmail") throw new Error("此邮箱暂不支持同步")
  if (!baseUrl(account)) throw new Error("请先填写 Cloud Mail 服务地址")
  if (!loadSecret(account.id)) throw new Error("请编辑账号并登录 Cloud Mail")
  if (!account.remoteAccountId) throw new Error("账号缺少服务端 ID，请重新登录")

  const accountId = account.remoteAccountId
  const allReceive = account.allReceive ?? 0
  let data: any
  if (latestEmailId) {
    data = await request(account, `/api/email/latest?emailId=${encodeURIComponent(latestEmailId)}&accountId=${accountId}&allReceive=${allReceive}`)
    if (!Array.isArray(data)) data = []
  } else {
    const params = [
      `accountId=${accountId}`,
      `allReceive=${allReceive}`,
      "emailId=9999999999",
      "timeSort=0",
      "size=20",
      "type=0",
    ].join("&")
    data = await request(account, `/api/email/list?${params}`)
  }
  const list = Array.isArray(data) ? data : data?.list
  if (!Array.isArray(list)) throw new Error("Cloud Mail 邮件列表格式异常")
  let r2Domain = account.r2Domain ?? ""
  if (account.r2Domain === undefined) {
    const websiteConfig = await fetchCloudMailWebsiteConfig(account).catch(() => undefined)
    r2Domain = websiteConfig?.r2Domain ?? ""
    if (websiteConfig) {
      account.r2Domain = r2Domain
      const accounts = loadAccounts()
      const index = accounts.findIndex(item => item.id === account.id)
      if (index >= 0) {
        accounts[index] = { ...accounts[index], r2Domain }
        saveAccounts(accounts)
      }
    }
  }
  return { messages: list.map((item: any, index: number) => normalizeMessage(item, account, index, r2Domain)), resetAccount: false }
}

export async function markMessageRead(account: MailAccount, messageId: string) {
  if (account.provider === "gmail") return markGmailMessageRead(account, messageId)
  if (account.provider === "microsoft") return markMicrosoftMessageRead(account, messageId)
  if (["qq", "netease163", "netease126", "yeah"].includes(account.provider)) return markImapMessageRead(account, messageId)
  if (account.provider !== "cloudmail") throw new Error("此邮箱暂不支持标记已读")
  await request(account, "/api/email/read", { method: "PUT", body: JSON.stringify({ emailIds: [Number(messageId)] }) })
}

export async function deleteMessage(account: MailAccount, messageId: string) {
  if (account.provider === "gmail") return trashGmailMessage(account, messageId)
  if (account.provider === "microsoft") return deleteMicrosoftMessage(account, messageId)
  if (["qq", "netease163", "netease126", "yeah"].includes(account.provider)) return deleteImapMessage(account, messageId)
  if (account.provider !== "cloudmail") throw new Error("此邮箱暂不支持删除")
  await request(account, `/api/email/delete?emailIds=${encodeURIComponent(messageId)}`, { method: "DELETE" })
}
