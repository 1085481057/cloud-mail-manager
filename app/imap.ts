import { stripEmailSignature } from "./models"
import type { MailAccount, MailAttachment, MailMessage } from "./models"
import { GMAIL_OAUTH_RELAY } from "./gmail-config"
import { MAIL_GATEWAY } from "./mail-gateway-config"
import { loadSecret } from "./store"
import { unsubscribeFromHeaders, unsubscribeFromHtml } from "./unsubscribe"
import { extractVerificationCode } from "./verification"

type ImapRawMessage = { uid: string; unread: boolean; internalDate?: string; raw: string; parsedText?: string; parsedHtml?: string; parsedFrom?: string; parsedTo?: string; parsedSubject?: string }
type ImapResponse = { ok?: boolean; email?: string; provider?: string; uidValidity?: string; messages?: ImapRawMessage[]; hasMore?: boolean; nextBeforeUID?: string; error?: string }
type RequestInit = { method?: string; headers?: Record<string, string>; body?: string }
declare function fetch(url: string, init?: RequestInit): Promise<any>

function bytesToBase64(bytes: number[]) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let result = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = bytes[index + 1]
    const c = bytes[index + 2]
    result += alphabet[a >> 2]
    result += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]
    result += b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]
    result += c === undefined ? "=" : alphabet[c & 63]
  }
  return result
}

function decodeBytes(bytes: number[], charset = "utf-8") {
  const normalized = charset.trim().toLowerCase().replace(/["']/g, "")
  const encoding: Encoding = /gb2312|gbk/.test(normalized) ? "gbk"
    : /gb18030/.test(normalized) ? "gb18030"
      : /iso-?8859-1|latin1/.test(normalized) ? "isoLatin1"
        : /shift[-_]?jis/.test(normalized) ? "shiftJIS"
          : "utf-8"
  return Data.fromBase64String(bytesToBase64(bytes))?.toRawString(encoding) ?? ""
}

function base64Bytes(value: string) {
  const data = Data.fromBase64String(value.replace(/\s/g, ""))
  const raw = data?.toRawString("isoLatin1") ?? ""
  return [...raw].map(character => character.charCodeAt(0) & 0xff)
}

function quotedPrintableBytes(value: string) {
  const source = value.replace(/=\r?\n/g, "")
  const bytes: number[] = []
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "=" && /^[0-9A-F]{2}$/i.test(source.slice(index + 1, index + 3))) {
      bytes.push(parseInt(source.slice(index + 1, index + 3), 16))
      index += 2
    } else bytes.push(source.charCodeAt(index) & 0xff)
  }
  return bytes
}

function decodeEncodedWords(value: string) {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, transfer: string, content: string) => {
    const bytes = transfer.toLowerCase() === "b" ? base64Bytes(content) : quotedPrintableBytes(content.replace(/_/g, " "))
    return decodeBytes(bytes, charset)
  }).replace(/\?=\s+=\?/g, "?==?")
}

function splitHeaderBody(value: string) {
  const match = value.match(/\r?\n\r?\n/)
  if (!match || match.index === undefined) return { headerText: value, body: "" }
  return { headerText: value.slice(0, match.index), body: value.slice(match.index + match[0].length) }
}

function headers(value: string) {
  const result = new Map<string, string>()
  const unfolded = value.replace(/\r?\n[ \t]+/g, " ")
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator < 1) continue
    result.set(line.slice(0, separator).trim().toLowerCase(), decodeEncodedWords(line.slice(separator + 1).trim()))
  }
  return result
}

function parameter(value: string, name: string) {
  const encoded = value.match(new RegExp(`${name}\\*=(?:[^']*)''([^;]+)`, "i"))?.[1]
  if (encoded) { try { return decodeURIComponent(encoded) } catch {} }
  return decodeEncodedWords(value.match(new RegExp(`${name}=(?:"([^"]*)"|([^;\\s]+))`, "i"))?.slice(1).find(Boolean) ?? "")
}

function decodePartBody(body: string, transfer: string, charset: string) {
  const mode = transfer.toLowerCase()
  const bytes = mode === "base64" ? base64Bytes(body) : mode === "quoted-printable" ? quotedPrintableBytes(body) : [...body].map(character => character.charCodeAt(0) & 0xff)
  return decodeBytes(bytes, charset)
}

type EmbeddedBody = { html: string; plain: string }
type ParsedMail = { html: string[]; plain: string[]; attachments: MailAttachment[]; embedded: EmbeddedBody[] }

function parsePart(raw: string, output: ParsedMail, embeddedDepth = 0) {
  const split = splitHeaderBody(raw)
  const partHeaders = headers(split.headerText)
  const contentType = partHeaders.get("content-type") ?? "text/plain; charset=utf-8"
  const mimeType = contentType.split(";", 1)[0].trim().toLowerCase()
  const boundary = parameter(contentType, "boundary")
  if (mimeType.startsWith("multipart/") && boundary) {
    const delimiter = `--${boundary}`
    for (const child of split.body.split(delimiter).slice(1)) {
      if (child.startsWith("--")) break
      parsePart(child.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), output, embeddedDepth)
    }
    return
  }
  const disposition = partHeaders.get("content-disposition") ?? ""
  const filename = parameter(disposition, "filename") || parameter(contentType, "name")
  const transfer = partHeaders.get("content-transfer-encoding") ?? ""
  const embeddedMail = mimeType === "message/rfc822" || mimeType === "message/global" || /\.eml$/i.test(filename)
  if (embeddedMail) {
    if (filename || /attachment/i.test(disposition)) output.attachments.push({ id: `${output.attachments.length}-${filename}`, filename: filename || "邮件.eml", mimeType, size: split.body.length, key: "" })
    if (embeddedDepth < 2 && split.body.length <= 2_000_000) {
      const nestedSource = decodePartBody(split.body, transfer, "iso-8859-1").trim()
      if (/^(?:from|subject|date|content-type|mime-version):/im.test(nestedSource) && /\r?\n\r?\n/.test(nestedSource)) {
        const nested: ParsedMail = { html: [], plain: [], attachments: [], embedded: [] }
        parsePart(nestedSource, nested, embeddedDepth + 1)
        output.attachments.push(...nested.attachments.map(item => ({ ...item, id: `${output.attachments.length}-${item.id}` })))
        const html = nested.html.filter(Boolean).at(-1) || nested.embedded.find(item => item.html)?.html || ""
        const plain = nested.plain.filter(Boolean).join("\n\n") || nested.embedded.find(item => item.plain)?.plain || ""
        if (html || plain) output.embedded.push({ html, plain })
      }
    }
    return
  }
  const explicitAttachment = /attachment/i.test(disposition)
  const readableText = mimeType === "text/html" || mimeType === "text/plain" || mimeType === "message/delivery-status" || (mimeType.startsWith("text/") && !/^(?:text\/calendar|text\/css)$/.test(mimeType))
  if (filename || explicitAttachment) {
    output.attachments.push({ id: `${output.attachments.length}-${filename}`, filename: filename || "附件", mimeType, size: split.body.length, key: "" })
    if (explicitAttachment || !readableText) return
  }
  const charset = parameter(contentType, "charset") || "utf-8"
  const content = decodePartBody(split.body, transfer, charset).trim()
  if (mimeType === "text/html" && content) output.html.push(content)
  else if (readableText && content) output.plain.push(content)
}

function htmlQuality(value: string) {
  const structure = (value.match(/<(?:table|tr|td|img|a|div|section|header|footer|style)\b/gi) ?? []).length
  return value.length + structure * 400
}

function bestHtml(values: Array<string | undefined>) {
  return values
    .map(value => value?.trim() ?? "")
    .filter(Boolean)
    .sort((a, b) => htmlQuality(b) - htmlQuality(a))[0] ?? ""
}

function stripHtml(value: string) {
  return value.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

function verificationCode(subject: string, body: string) {
  return extractVerificationCode(subject, body)
}

function parseImapDate(headerDate?: string, internalDate?: string): string {
  const candidates = [headerDate, internalDate].filter(Boolean) as string[]
  for (const raw of candidates) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed)
      const ms = num < 1e11 ? num * 1000 : num
      return new Date(ms).toISOString()
    }
    let parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed) && parsed > 0) return new Date(parsed).toISOString()
    const cleaned = trimmed.replace(/\([A-Za-z0-9_+\-\s]+\)/g, "").trim()
    parsed = Date.parse(cleaned)
    if (Number.isFinite(parsed) && parsed > 0) return new Date(parsed).toISOString()
  }
  return new Date().toISOString()
}

function normalize(raw: ImapRawMessage & { uidValidity?: string }, account: MailAccount): MailMessage {
  const source = Data.fromBase64String(raw.raw)?.toRawString("isoLatin1") ?? ""
  const split = splitHeaderBody(source)
  const rootHeaders = headers(split.headerText)
  const parsed: ParsedMail = { html: [], plain: [], attachments: [], embedded: [] }
  parsePart(source, parsed)
  const serverHtml = String(raw.parsedHtml ?? "").trim()
  const serverPlain = String(raw.parsedText ?? "").trim()
  const outerHtml = bestHtml([...parsed.html, serverHtml])
  const outerPlain = parsed.plain.map(value => value.trim()).filter(Boolean).join("\n\n") || serverPlain
  const embedded = parsed.embedded.find(item => item.plain || item.html)
  const html = outerHtml || (!outerPlain ? embedded?.html ?? "" : "")
  const plain = outerPlain || (!outerHtml ? embedded?.plain ?? "" : "")
  const bodyContent = plain || stripHtml(html)
  const body = bodyContent ? `${!outerPlain && !outerHtml && embedded ? "原始邮件内容：\n\n" : ""}${bodyContent}` : "此邮件没有可显示的正文。"
  const subject = String(raw.parsedSubject ?? "").trim() || rootHeaders.get("subject") || "（无主题）"
  const unsubscribe = unsubscribeFromHeaders(rootHeaders.get("list-unsubscribe") ?? "", rootHeaders.get("list-unsubscribe-post") ?? "") ?? unsubscribeFromHtml(html)
  return {
    id: `${raw.uidValidity ?? ""}:${raw.uid}`, accountId: account.id, provider: account.provider, from: String(raw.parsedFrom ?? "").trim() || rootHeaders.get("from") || "未知发件人", to: String(raw.parsedTo ?? "").trim() || rootHeaders.get("to"), subject,
    preview: (stripEmailSignature(body) || body).slice(0, 120), body, html: html || undefined, date: parseImapDate(rootHeaders.get("date"), raw.internalDate), unread: raw.unread,
    verificationCode: verificationCode(subject, body), attachments: parsed.attachments, unsubscribeUrl: unsubscribe?.url, unsubscribeOneClick: unsubscribe?.oneClick,
  }
}

async function imapRequest(account: MailAccount, action: string, extra: Record<string, unknown> = {}, authorizationCode?: string): Promise<ImapResponse> {
  const secret = authorizationCode ?? loadSecret(account.id)
  if (!secret) throw new Error("请先填写邮箱授权码")
  
  // 如果由于网易太慢导致抛出 Timeout，其实底层的 worker 可能还在执行，
  // 我们不再完全等 15 秒死锁，改成：只要 timeout，就不抛错，而是返回空，让前台列表当做没新邮件但不断开，后续让它自己刷
  let abortRef = { aborted: false }
  const timeoutMs = 15000
  const timeout = setTimeout(() => { abortRef.aborted = true }, timeoutMs)

  try {
    const response = await Promise.race([
      fetch(`${MAIL_GATEWAY.origin}/v1/mail/${action === "test" ? "accounts/verify" : action === "messages" ? "messages/list" : "messages/modify"}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${GMAIL_OAUTH_RELAY.clientSecret}` },
        body: JSON.stringify({ action, operation: action, provider: account.provider, email: account.address, authorizationCode: secret, ...extra })
      }),
      new Promise<never>((_, reject) => setTimeout(() => { abortRef.aborted = true; reject(new Error("Timeout")) }, timeoutMs))
    ])
    clearTimeout(timeout)
    if (abortRef.aborted) throw new Error(`连接网易服务器超时 (${timeoutMs / 1000}s)`)
    const raw = await response.text()
    let payload: { data?: ImapResponse; error?: { message?: string } | string } & ImapResponse
    try { payload = raw ? JSON.parse(raw) : {} } catch { throw new Error(`邮箱服务返回异常（HTTP ${response.status}）`) }
    if (!response.ok) {
      const gatewayError: any = payload.error
      throw new Error(typeof gatewayError === "string" ? gatewayError : gatewayError?.message || `邮箱请求失败（HTTP ${response.status}）`)
    }
    return payload.data ?? payload
  } catch (error) {
    clearTimeout(timeout)
    if (abortRef.aborted || String(error).includes("AbortError") || String(error).includes("aborted")) {
      // 在拉取列表时，如果网易网关响应过慢，不应抛错导致前台一直显示报错或卡死，而是直接返回空集合
      if (action === "messages") {
         return { messages: [], hasMore: true, nextBeforeUID: extra.beforeUID ? String(extra.beforeUID) : undefined, uidValidity: extra.expectedUIDValidity ? String(extra.expectedUIDValidity) : undefined } as any
      }
      throw new Error(`连接网易服务器超时 (${timeoutMs / 1000}s)`)
    }
    throw error
  }
}

export async function testImapAccount(account: MailAccount, authorizationCode: string) {
  await imapRequest(account, "test", {}, authorizationCode)
}

export const testQQAccount = testImapAccount

export type FetchImapOptions = {
  beforeUID?: string
  sinceUID?: string
  searchUID?: string
  rfcMessageId?: string
  expectedUIDValidity?: string
}

export async function fetchImapMessagesPage(account: MailAccount, options?: FetchImapOptions | string) {
  const extra: Record<string, unknown> = {}
  if (typeof options === "string") {
    if (options) extra.beforeUID = options
  } else if (options) {
    if (options.beforeUID) extra.beforeUID = options.beforeUID
    if (options.sinceUID) extra.sinceUID = options.sinceUID
    if (options.searchUID) extra.searchUID = options.searchUID
    if (options.rfcMessageId) extra.rfcMessageId = options.rfcMessageId
    if (options.expectedUIDValidity) extra.expectedUIDValidity = options.expectedUIDValidity
  }
  const payload = await imapRequest(account, "messages", extra)
  return { messages: (payload.messages ?? []).map(item => normalize({ ...item, uidValidity: payload.uidValidity }, account)), hasMore: Boolean(payload.hasMore), nextBeforeUID: payload.nextBeforeUID, uidValidity: payload.uidValidity }
}

export const fetchQQMessagesPage = fetchImapMessagesPage

function messageIdentity(messageId: string) {
  const separator = messageId.indexOf(":")
  if (separator <= 0) throw new Error("邮件缓存已过期，请刷新收件箱后重试")
  return { uidValidity: messageId.slice(0, separator), uid: messageId.slice(separator + 1) }
}

export async function markImapMessageRead(account: MailAccount, messageId: string) {
  await imapRequest(account, "read", messageIdentity(messageId))
}

export const markQQMessageRead = markImapMessageRead

export async function deleteImapMessage(account: MailAccount, messageId: string) {
  await imapRequest(account, "delete", messageIdentity(messageId))
}

export const deleteQQMessage = deleteImapMessage
