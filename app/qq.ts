import type { MailAccount, MailAttachment, MailMessage } from "./models"
import { GMAIL_OAUTH_RELAY } from "./gmail-config"
import { loadSecret } from "./store"
import { unsubscribeFromHeaders, unsubscribeFromHtml } from "./unsubscribe"

type QQRawMessage = { uid: string; unread: boolean; internalDate?: string; raw: string }
type QQResponse = { ok?: boolean; email?: string; messages?: QQRawMessage[]; hasMore?: boolean; nextBeforeUID?: string; error?: string }
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
  const embeddedMail = mimeType === "message/rfc822" || /\.eml$/i.test(filename)
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
  if (filename || /attachment/i.test(disposition)) {
    output.attachments.push({ id: `${output.attachments.length}-${filename}`, filename: filename || "附件", mimeType, size: split.body.length, key: "" })
    return
  }
  const charset = parameter(contentType, "charset") || "utf-8"
  const content = decodePartBody(split.body, transfer, charset).trim()
  if (mimeType === "text/html" && content) output.html.push(content)
  else if ((mimeType === "text/plain" || mimeType === "message/delivery-status") && content) output.plain.push(content)
}

function stripHtml(value: string) {
  return value.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

function verificationCode(subject: string, body: string) {
  const source = `${subject}\n${body}`
  if (!/(?:验证码|校验码|动态码|登录码|安全码|verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP)/i.test(source)) return undefined
  return source.match(/(?:验证码|校验码|动态码|登录码|安全码|verification\s*code|security\s*code|login\s*code|passcode|OTP)[^A-Z0-9]{0,24}([A-Z0-9]{4,8})/i)?.[1]
}

function normalize(raw: QQRawMessage, account: MailAccount): MailMessage {
  const source = Data.fromBase64String(raw.raw)?.toRawString("isoLatin1") ?? ""
  const split = splitHeaderBody(source)
  const rootHeaders = headers(split.headerText)
  const parsed: ParsedMail = { html: [], plain: [], attachments: [], embedded: [] }
  parsePart(source, parsed)
  const outerHtml = parsed.html.filter(Boolean).at(-1) ?? ""
  const outerPlain = parsed.plain.filter(Boolean).join("\n\n")
  const embedded = parsed.embedded.find(item => item.plain || item.html)
  const html = outerHtml || (!outerPlain ? embedded?.html ?? "" : "")
  const plain = outerPlain || (!outerHtml ? embedded?.plain ?? "" : "")
  const bodyContent = plain || stripHtml(html)
  const body = bodyContent ? `${!outerPlain && !outerHtml && embedded ? "原始邮件内容：\n\n" : ""}${bodyContent}` : "此邮件没有可显示的正文。"
  const subject = rootHeaders.get("subject") || "（无主题）"
  const unsubscribe = unsubscribeFromHeaders(rootHeaders.get("list-unsubscribe") ?? "", rootHeaders.get("list-unsubscribe-post") ?? "") ?? unsubscribeFromHtml(html)
  const dateValue = rootHeaders.get("date") || raw.internalDate
  const timestamp = dateValue ? Date.parse(dateValue) : NaN
  return {
    id: raw.uid, accountId: account.id, provider: "qq", from: rootHeaders.get("from") || "未知发件人", to: rootHeaders.get("to"), subject,
    preview: body.slice(0, 120), body, html: html || undefined, date: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString(), unread: raw.unread,
    verificationCode: verificationCode(subject, body), attachments: parsed.attachments, unsubscribeUrl: unsubscribe?.url, unsubscribeOneClick: unsubscribe?.oneClick,
  }
}

async function qqRequest(account: MailAccount, action: string, extra: Record<string, unknown> = {}, authorizationCode?: string): Promise<QQResponse> {
  const secret = authorizationCode ?? loadSecret(account.id)
  if (!secret) throw new Error("请先填写 QQ 邮箱授权码")
  const response = await fetch(`${GMAIL_OAUTH_RELAY.origin}/qq/imap`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${GMAIL_OAUTH_RELAY.clientSecret}` },
    body: JSON.stringify({ action, email: account.address, authorizationCode: secret, ...extra }),
  })
  const raw = await response.text()
  let payload: QQResponse
  try { payload = raw ? JSON.parse(raw) : {} } catch { throw new Error(`QQ 邮箱服务返回异常（HTTP ${response.status}）`) }
  if (!response.ok) throw new Error(payload.error || `QQ 邮箱请求失败（HTTP ${response.status}）`)
  return payload
}

export async function testQQAccount(account: MailAccount, authorizationCode: string) {
  await qqRequest(account, "test", {}, authorizationCode)
}

export async function fetchQQMessagesPage(account: MailAccount, beforeUID?: string) {
  const payload = await qqRequest(account, "messages", beforeUID ? { beforeUID } : {})
  return { messages: (payload.messages ?? []).map(item => normalize(item, account)), hasMore: Boolean(payload.hasMore), nextBeforeUID: payload.nextBeforeUID }
}

export async function markQQMessageRead(account: MailAccount, uid: string) {
  await qqRequest(account, "read", { uid })
}

export async function deleteQQMessage(account: MailAccount, uid: string) {
  await qqRequest(account, "delete", { uid })
}
