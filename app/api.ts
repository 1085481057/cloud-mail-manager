import { isMessageMatch, stripEmailSignature } from "./models"
import type { CloudMailRemoteAccount, CloudMailWebsiteConfig, MailAccount, MailAttachment, MailMessage } from "./models"
import { loadSecret, saveAccounts, saveSecret, loadAccounts, loadGmailPagination, saveGmailPagination, removeAccountMessageSnapshot, loadMessageSnapshot, loadMessageContent, isMessageContentFull, saveMessageContent } from "./store"
import { fetchGmailMessageDetail, fetchGmailMessagesPage, markGmailMessageRead, trashGmailMessage } from "./gmail"
import { unsubscribeFromHtml } from "./unsubscribe"
import { deleteImapMessage, fetchImapMessagesPage, markImapMessageRead } from "./imap"
import { deleteMicrosoftMessage, fetchMicrosoftMessageDetail, fetchMicrosoftMessagesPage, markMicrosoftMessageRead } from "./microsoft"
import { extractVerificationCode } from "./verification"

type RequestInit = { method?: string; headers?: Record<string, string>; body?: string }
declare function fetch(url: string, init?: RequestInit): Promise<any>

type Envelope = { code?: number; message?: string; data?: any }

const gmailNextPageTokens = new Map<string, string | undefined>()
const gmailPaginationStarted = new Set<string>()
const singleMessageRequests = new Map<string, Promise<MailMessage | null>>()

function singleMessageRequestKey(account: MailAccount, messageId: string, subject?: string, from?: string) {
  // 通知使用 RFC Message-ID，收件箱使用 UID；主题+发件人让两条路径共享同一个请求。
  const identity = subject?.trim() || from?.trim() ? `${subject ?? ""}:${from ?? ""}` : messageId
  return `${account.id}:${identity}`
}

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

export function parseDateString(value: unknown): string {
  if (!value) return new Date().toISOString()
  if (typeof value === "number") {
    const ms = value < 1e11 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  let str = String(value).trim()
  if (/^\d+$/.test(str)) {
    const num = Number(str)
    const ms = num < 1e11 ? num * 1000 : num
    return new Date(ms).toISOString()
  }
  // Cloud Mail / 服务端数据库存储的 createTime 往往是 UTC 时间字符串（如 2026-10-05 15:40:00），无 Z 后缀
  // 若直接 Date.parse 会被 JS 误作为设备本地时间解析导致少 8 小时。识别标准无时区日期并补齐 Z
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(str)) {
    str = str.replace(" ", "T") + "Z"
  }
  const parsed = Date.parse(str)
  if (Number.isFinite(parsed) && parsed > 0) return new Date(parsed).toISOString()
  return str || new Date().toISOString()
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
    preview: (stripEmailSignature(body) || body).slice(0, 120),
    body: body || "此邮件只有 HTML 正文，请在 Cloud Mail 网页端查看。",
    html,
    date: parseDateString(raw.createTime ?? raw.date ?? raw.created_at),
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
    let currentDeletedIds = account.deletedIds || []
    if (index >= 0) {
      currentDeletedIds = accounts[index].deletedIds || []
      accounts[index] = { ...accounts[index], qqBeforeUID: page.nextBeforeUID || account.qqBeforeUID, qqPaginationEnded: !page.hasMore, syncState: { cursor: page.nextBeforeUID, ended: !page.hasMore, uidValidity: page.uidValidity } }
      saveAccounts(accounts)
    }
    return { messages: page.messages.filter(m => !currentDeletedIds.includes(m.id)), hasMore: page.hasMore }
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
    let options: any = undefined
    if (latestEmailId && latestEmailId.includes(":")) {
      const [uidValidity, uid] = latestEmailId.split(":")
      options = { sinceUID: uid, expectedUIDValidity: uidValidity }
    }
    const page = await fetchImapMessagesPage(account, options)
    const accounts = loadAccounts()
    const index = accounts.findIndex(item => item.id === account.id)
    let mailboxChanged = false
    let currentDeletedIds = account.deletedIds || []
    if (index >= 0) {
      currentDeletedIds = accounts[index].deletedIds || []
      mailboxChanged = Boolean(accounts[index].syncState?.uidValidity && page.uidValidity && accounts[index].syncState?.uidValidity !== page.uidValidity)
      if (mailboxChanged) removeAccountMessageSnapshot(account.id)
      if (mailboxChanged || !accounts[index].syncState?.cursor) {
        accounts[index] = { ...accounts[index], qqBeforeUID: page.nextBeforeUID, qqPaginationEnded: !page.hasMore, syncState: { cursor: page.nextBeforeUID, ended: !page.hasMore, uidValidity: page.uidValidity } }
        saveAccounts(accounts)
      }
    }
    return { messages: page.messages.filter(m => !currentDeletedIds.includes(m.id)), resetAccount: mailboxChanged }
  }
  if (account.provider !== "cloudmail") throw new Error("此邮箱暂不支持同步")
  if (!baseUrl(account)) throw new Error("请先填写 Cloud Mail 服务地址")
  if (!loadSecret(account.id)) throw new Error("请编辑账号并登录 Cloud Mail")
  if (!account.remoteAccountId) throw new Error("账号缺少服务端 ID，请重新登录")

  const accountId = account.remoteAccountId
  const allReceive = account.allReceive ?? 0

  if (latestEmailId) {
    const params = new URLSearchParams({
      accountId: String(accountId),
      allReceive: String(allReceive),
      emailId: latestEmailId,
      size: "10"
    })
    const data = await request(account, `/api/email/latest?${params.toString()}`).catch(() => null)
    if (data) {
      const list = Array.isArray(data) ? data : data?.list
      if (Array.isArray(list)) {
        let r2Domain = account.r2Domain ?? ""
        const messages = list.map((item: any, index: number) => normalizeMessage(item, account, index, r2Domain))
        if (messages.length > 0) {
          return { messages, resetAccount: false }
        } else {
          return { messages: [], resetAccount: false }
        }
      }
    }
  }

  // 如果没有 latestEmailId 或者 latest 接口异常，走全量/初次拉取最新逻辑
  const params = [
    `accountId=${accountId}`,
    `allReceive=${allReceive}`,
    "emailId=9999999999",
    "timeSort=0",
    "size=20",
    "type=0",
  ].join("&")
  const data = await request(account, `/api/email/list?${params}`)
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
  if (["qq", "netease163", "netease126", "yeah"].includes(account.provider)) {
    // 关键修复：如果 messageId 是没有冒号的通知临时 ID（如 notif-xxx 或 RFC Message-ID）
    if (!messageId.includes(":")) {
      const snapshot = loadMessageSnapshot()
      const targetInSnapshot = snapshot.find(m => m.id === messageId)
      const realMessage = snapshot.find(m => 
        m.accountId === account.id && 
        m.id.includes(":") && 
        (m.id === messageId || (targetInSnapshot && m.subject === targetInSnapshot.subject && m.from === targetInSnapshot.from))
      )
      if (realMessage) {
        return markImapMessageRead(account, realMessage.id).catch(() => {})
      }
      // 没有对应服务器 UID 的纯本地通知条目，本地已标记已读，直接返回成功！
      return
    }
    return markImapMessageRead(account, messageId).catch(error => {
      console.warn("markImapMessageRead non-fatal:", error)
    })
  }
  if (account.provider !== "cloudmail") throw new Error("此邮箱暂不支持标记已读")
  await request(account, "/api/email/read", { method: "PUT", body: JSON.stringify({ emailIds: [Number(messageId)] }) })
}

export async function deleteMessage(account: MailAccount, messageId: string) {
  const accounts = loadAccounts()
  const index = accounts.findIndex(a => a.id === account.id)
  if (index >= 0) {
    const deletedIds = accounts[index].deletedIds || []
    if (!deletedIds.includes(messageId)) {
      accounts[index] = { ...accounts[index], deletedIds: [...deletedIds, messageId].slice(-2000) }
      saveAccounts(accounts)
    }
  }

  if (account.provider === "gmail") return trashGmailMessage(account, messageId)
  if (account.provider === "microsoft") return deleteMicrosoftMessage(account, messageId)
  if (["qq", "netease163", "netease126", "yeah"].includes(account.provider)) {
    // 关键修复：如果 messageId 是没有冒号的通知临时 ID（如 notif-xxx 或 RFC Message-ID）
    if (!messageId.includes(":")) {
      const snapshot = loadMessageSnapshot()
      const targetInSnapshot = snapshot.find(m => m.id === messageId)
      const realMessage = snapshot.find(m => 
        m.accountId === account.id && 
        m.id.includes(":") && 
        (m.id === messageId || (targetInSnapshot && m.subject === targetInSnapshot.subject && m.from === targetInSnapshot.from))
      )
      if (realMessage) {
        const accountsNow = loadAccounts()
        const accIdx = accountsNow.findIndex(a => a.id === account.id)
        if (accIdx >= 0) {
          const dIds = accountsNow[accIdx].deletedIds || []
          if (!dIds.includes(realMessage.id)) {
            accountsNow[accIdx].deletedIds = [...dIds, realMessage.id].slice(-2000)
            saveAccounts(accountsNow)
          }
        }
        return deleteImapMessage(account, realMessage.id).catch(() => {})
      }
      return
    }
    return deleteImapMessage(account, messageId)
  }
  if (account.provider !== "cloudmail") throw new Error("此邮箱暂不支持删除")
  await request(account, `/api/email/delete?emailIds=${encodeURIComponent(messageId)}`, { method: "DELETE" })
}

export async function fetchSingleMessage(account: MailAccount, messageId: string, fallbackSubject?: string, fallbackFrom?: string, fallbackDate?: string | Date, fallbackPreview?: string, forceRefresh = false): Promise<MailMessage | null> {
  if (!account.enabled) return null
  const requestKey = singleMessageRequestKey(account, messageId, fallbackSubject, fallbackFrom)
  const existingRequest = singleMessageRequests.get(requestKey)
  if (existingRequest) return existingRequest
  const request = fetchSingleMessageUnshared(account, messageId, fallbackSubject, fallbackFrom, fallbackDate, fallbackPreview, forceRefresh)
  singleMessageRequests.set(requestKey, request)
  request.finally(() => {
    if (singleMessageRequests.get(requestKey) === request) singleMessageRequests.delete(requestKey)
  }).catch(() => {})
  return request
}

async function fetchSingleMessageUnshared(account: MailAccount, messageId: string, fallbackSubject?: string, fallbackFrom?: string, fallbackDate?: string | Date, fallbackPreview?: string, forceRefresh = false): Promise<MailMessage | null> {

  // 1. 如果不是强制刷新，首先检查本地快照并 hydration，若已有完整正文则直接返回
  if (!forceRefresh) {
    try {
      const snapshot = loadMessageSnapshot()
      const cached = snapshot.find(m => 
        !m.isPlaceholder && 
        m.accountId === account.id && 
        isMessageMatch(
          { id: m.id, subject: m.subject, from: m.from, date: m.date, preview: m.preview },
          messageId,
          fallbackSubject,
          fallbackFrom,
          fallbackDate,
          fallbackPreview
        )
      )
      if (cached) {
        const hydrated = loadMessageContent(cached)
        if (isMessageContentFull(hydrated)) {
          return hydrated
        }
      }
    } catch {}
  }

  if (account.provider === "gmail") {
    return await fetchGmailMessageDetail(account, messageId, fallbackSubject, fallbackFrom, fallbackDate, fallbackPreview)
  }
  if (account.provider === "microsoft") {
    return await fetchMicrosoftMessageDetail(account, messageId)
  }
  if (account.provider === "cloudmail") {
    const accountId = account.remoteAccountId
    const allReceive = account.allReceive ?? 0
    // 直接权威拉取最新 20 封邮件，覆盖新邮件到达与绝大多数单封查看场景
    const params = [
      `accountId=${accountId}`,
      `allReceive=${allReceive}`,
      "emailId=9999999999",
      "timeSort=0",
      "size=5",
      "type=0",
    ].join("&")
    const data = await request(account, `/api/email/list?${params}`)
    const list = Array.isArray(data) ? data : data?.list
    if (Array.isArray(list)) {
      const found = list.find((item: any) => 
        isMessageMatch(
          {
            emailId: item.emailId ?? item.id,
            subject: text(item.subject),
            name: text(item.name),
            sendEmail: text(item.sendEmail),
            date: item.createTime ?? item.date,
            preview: text(item.preview ?? item.text),
          },
          messageId,
          fallbackSubject,
          fallbackFrom,
          fallbackDate,
          fallbackPreview
        )
      )
      if (found) {
        const msg = normalizeMessage(found, account, 0, account.r2Domain ?? "")
        saveMessageContent(msg)
        return msg
      }
    }

    // 兜底：如果 messageId 是具体纯数字且不在前 20 封中（较旧的历史邮件）
    if (/^\d+$/.test(messageId)) {
      const targetIdNum = Number(messageId)
      const olderParams = [
        `accountId=${accountId}`,
        `allReceive=${allReceive}`,
        `emailId=${targetIdNum + 10}`,
        "timeSort=0",
        "size=20",
        "type=0",
      ].join("&")
      const olderData = await request(account, `/api/email/list?${olderParams}`).catch(() => null)
      const olderList = Array.isArray(olderData) ? olderData : olderData?.list
      if (Array.isArray(olderList)) {
        const found = olderList.find((item: any) => String(item.emailId ?? item.id) === messageId)
        if (found) {
          const msg = normalizeMessage(found, account, 0, account.r2Domain ?? "")
          saveMessageContent(msg)
          return msg
        }
      }
    }
  }
  if (["qq", "netease163", "netease126", "yeah"].includes(account.provider)) {
    try {
      const snapshot = loadMessageSnapshot()
      const accountMessages = snapshot.filter(m => m.accountId === account.id && !m.isPlaceholder)
      const latestMessage = accountMessages[0]
      let found = accountMessages.find(item => 
        isMessageMatch(
          { id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview },
          messageId,
          fallbackSubject,
          fallbackFrom,
          fallbackDate,
          fallbackPreview
        )
      )

      if (found) {
        const hydrated = loadMessageContent(found)
        if (isMessageContentFull(hydrated)) return hydrated
      }

      let options: any = undefined
      // 为了能够真正拿到你想点击的具体那一封邮件正文，我们直接请求它的 UID，不再用增量模糊查找
      if (messageId && messageId.includes(":")) {
        const [uidValidity, uid] = messageId.split(":")
        // 传递 searchUID 让 worker 直接搜索指定的 UID 并返回单封完整正文，不拉多余列表
        options = { searchUID: uid, expectedUIDValidity: uidValidity }
      } else if (messageId && messageId.includes("@")) {
        options = { rfcMessageId: messageId }
      } else if (!forceRefresh && latestMessage && latestMessage.id.includes(":")) {
        const [uidValidity, uid] = latestMessage.id.split(":")
        // 请求该账号已有最新邮件之后的增量，防止全量拉取卡死 10 秒
        options = { sinceUID: uid, expectedUIDValidity: uidValidity }
      }
      let page = await fetchImapMessagesPage(account, options)
      found = page.messages.find(item => 
        isMessageMatch(
          { id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview },
          messageId,
          fallbackSubject,
          fallbackFrom,
          fallbackDate,
          fallbackPreview
        )
      )

      // 关键兜底：如果用特定条件（如 searchUID / rfcMessageId）没找到，直接拉取该账号最新的前 5 封邮件！
      // 刚收到的邮件必定在收件箱最顶部，1 秒内直接命中完整邮件（含富文本 HTML 和小尾巴）！
      if (!found && options) {
        page = await fetchImapMessagesPage(account, undefined)
        found = page.messages.find(item => 
          isMessageMatch(
            { id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview },
            messageId,
            fallbackSubject,
            fallbackFrom,
            fallbackDate,
            fallbackPreview
          )
        )
      }

      if (found) {
        saveMessageContent(found)
        return found
      }
    } catch {}
  }

  // 最终兜底：如果网络请求由于临时断网或未命中，检查本地快照中是否已有匹配的真实邮件并进行 hydration
  try {
    const snapshot = loadMessageSnapshot()
    const localMatch = snapshot.find(m => 
      !m.isPlaceholder && 
      m.accountId === account.id && 
      isMessageMatch(
        { id: m.id, subject: m.subject, from: m.from, date: m.date, preview: m.preview },
        messageId,
        fallbackSubject,
        fallbackFrom,
        fallbackDate,
        fallbackPreview
      )
    )
    if (localMatch) {
      const hydrated = loadMessageContent(localMatch)
      if (isMessageContentFull(hydrated)) return hydrated
      return hydrated
    }
  } catch {}

  return null
}

