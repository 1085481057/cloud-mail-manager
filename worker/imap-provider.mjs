import { connect } from "cloudflare:sockets"

const encoder = new TextEncoder()

const PROVIDERS = Object.freeze({
  qq: { hostname: "imap.qq.com", port: 993, email: /^[^\s@]+@qq\.com$/i, label: "QQ 邮箱" },
  netease163: { hostname: "imap.163.com", port: 993, email: /^[^\s@]+@163\.com$/i, label: "网易 163 邮箱", requiresID: true },
  netease126: { hostname: "imap.126.com", port: 993, email: /^[^\s@]+@126\.com$/i, label: "网易 126 邮箱" },
  yeah: { hostname: "imap.yeah.net", port: 993, email: /^[^\s@]+@yeah\.net$/i, label: "Yeah 邮箱" },
})

function concat(left, right) {
  const output = new Uint8Array(left.length + right.length)
  output.set(left)
  output.set(right, left.length)
  return output
}

function ascii(bytes) {
  return new TextDecoder("utf-8").decode(bytes)
}

function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "")}"`
}

function neteaseLoginFailure(line) {
  const value = String(line).toLowerCase()
  if (/too many|frequency|rate|limit|temporar|try again/.test(value)) return "网易 163 登录请求过于频繁，请稍后再试"
  if (/unsafe|security|risk|blocked|suspicious|forbid/.test(value)) return "网易 163 阻止了当前网络的第三方登录，请先在网页版解除安全限制"
  if (/auth|password|credential|invalid|login failed|incorrect/.test(value)) return "网易 163 授权码无效或已失效，请重新生成"
  return "网易 163 认证被拒绝，请确认邮箱地址和最新授权码"
}

function base64(bytes) {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

class ImapSession {
  constructor(preset) {
    this.preset = preset
    this.socket = connect({ hostname: preset.hostname, port: preset.port }, { secureTransport: "on" })
    this.reader = this.socket.readable.getReader()
    this.writer = this.socket.writable.getWriter()
    this.buffer = new Uint8Array()
    this.counter = 0
  }

  async readUntil(marker) {
    const needle = encoder.encode(marker)
    while (true) {
      for (let index = 0; index <= this.buffer.length - needle.length; index++) {
        let matched = true
        for (let offset = 0; offset < needle.length; offset++) {
          if (this.buffer[index + offset] !== needle[offset]) { matched = false; break }
        }
        if (matched) {
          const end = index + needle.length
          const result = this.buffer.slice(0, end)
          this.buffer = this.buffer.slice(end)
          return result
        }
      }
      const { value, done } = await this.reader.read()
      if (done) throw new Error(`${this.preset.label} IMAP 连接提前关闭`)
      this.buffer = concat(this.buffer, value)
      if (this.buffer.length > 30_000_000) throw new Error(`${this.preset.label}邮件超过网关处理上限`)
    }
  }

  async command(value, failureMessage) {
    const tag = `A${String(++this.counter).padStart(4, "0")}`
    await this.writer.write(encoder.encode(`${tag} ${value}\r\n`))
    let response = new Uint8Array()
    while (true) {
      const line = await this.readUntil("\r\n")
      response = concat(response, line)
      const lineText = ascii(line)
      const literalLength = Number(lineText.match(/\{(\d+)\}\r\n$/)?.[1] ?? -1)
      if (literalLength >= 0) {
        while (this.buffer.length < literalLength) {
          const { value: chunk, done } = await this.reader.read()
          if (done) throw new Error(`${this.preset.label} IMAP 连接提前关闭`)
          this.buffer = concat(this.buffer, chunk)
          if (this.buffer.length > 30_000_000) throw new Error(`${this.preset.label}邮件超过网关处理上限`)
        }
        response = concat(response, this.buffer.slice(0, literalLength))
        this.buffer = this.buffer.slice(literalLength)
        continue
      }
      const status = lineText.match(new RegExp(`^${tag} (OK|NO|BAD)\\b`, "i"))?.[1]?.toUpperCase()
      if (!status) continue
      if (status !== "OK") {
        const sanitizedFailure = typeof failureMessage === "function" ? failureMessage(lineText) : failureMessage
        throw new Error(sanitizedFailure ?? (status === "NO" ? `${this.preset.label}拒绝了请求，请检查授权码或 IMAP 设置` : `${this.preset.label} IMAP 请求失败`))
      }
      return response
    }
  }

  async login(email, authorizationCode) {
    await this.readUntil("\r\n")
    await this.command(
      `LOGIN ${quote(email)} ${quote(authorizationCode)}`,
      this.preset.requiresID ? neteaseLoginFailure : `${this.preset.label}认证失败，请确认使用最新授权码`,
    )
    if (this.preset.requiresID) {
      await this.command(
        'ID ("name" "Cloud Mail Manager" "version" "1.0" "vendor" "Cloud Mail" "support-email" "support@cloudmail.invalid")',
        `${this.preset.label}拒绝了客户端身份，请稍后重试`,
      )
    }
    return this.command(
      'SELECT "INBOX"',
      `${this.preset.label}阻止了收件箱访问，请在网页版解除安全限制`,
    )
  }

  async close() {
    try { await this.command("LOGOUT") } catch {}
    try { await this.writer.close() } catch {}
    try { await this.socket.close() } catch {}
  }
}

function parseUIDs(response) {
  const match = ascii(response).match(/\* SEARCH([^\r\n]*)/i)
  return (match?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite)
}

function parseFetch(response, uid) {
  const text = ascii(response)
  const literal = text.match(/BODY\[\] \{(\d+)\}\r\n/i)
  if (!literal || literal.index === undefined) throw new Error("IMAP 未返回邮件正文")
  const length = Number(literal[1])
  const prefixLength = encoder.encode(text.slice(0, literal.index + literal[0].length)).length
  const raw = response.slice(prefixLength, prefixLength + length)
  const metadata = text.slice(0, literal.index)
  const flags = metadata.match(/FLAGS \(([^)]*)\)/i)?.[1] ?? ""
  const internalDate = metadata.match(/INTERNALDATE "([^"]+)"/i)?.[1]
  return { uid: String(uid), unread: !/\\Seen/i.test(flags), internalDate, raw: base64(raw) }
}

function uidValidity(response) {
  return ascii(response).match(/\[UIDVALIDITY (\d+)\]/i)?.[1]
}

async function withSession(preset, email, authorizationCode, operation) {
  const session = new ImapSession(preset)
  try {
    const selected = await session.login(email, authorizationCode)
    return await operation(session, uidValidity(selected))
  } finally {
    await session.close()
  }
}

function credentials(body) {
  const provider = String(body?.provider ?? "qq")
  const preset = PROVIDERS[provider]
  if (!preset) throw new Error("不支持的邮箱服务")
  const email = String(body?.email ?? "").trim().toLowerCase()
  const authorizationCode = String(body?.authorizationCode ?? "").trim()
  if (!preset.email.test(email)) throw new Error(`请输入有效的${preset.label}地址`)
  if (!authorizationCode) throw new Error(`请输入${preset.label}授权码`)
  return { provider, preset, email, authorizationCode }
}

export async function handleImap(body) {
  const { provider, preset, email, authorizationCode } = credentials(body)
  const action = String(body?.action ?? "")
  return withSession(preset, email, authorizationCode, async (session, mailboxUIDValidity) => {
    if (action === "test") return { ok: true, provider, email, uidValidity: mailboxUIDValidity }
    if (action === "messages") {
      const beforeUID = Number(body?.beforeUID ?? 0)
      const search = beforeUID > 1 ? `UID SEARCH UID 1:${beforeUID - 1}` : "UID SEARCH ALL"
      const uids = parseUIDs(await session.command(search)).sort((a, b) => b - a).slice(0, 10)
      const messages = []
      for (const uid of uids) {
        messages.push(parseFetch(await session.command(`UID FETCH ${uid} (UID FLAGS INTERNALDATE BODY.PEEK[])`), uid))
      }
      return { provider, uidValidity: mailboxUIDValidity, messages, hasMore: uids.length === 10, nextBeforeUID: uids.length ? String(Math.min(...uids)) : undefined }
    }
    const uid = String(body?.uid ?? "")
    const expectedUIDValidity = String(body?.uidValidity ?? "")
    if (!/^\d+$/.test(uid)) throw new Error("邮件 UID 无效")
    if (!expectedUIDValidity || expectedUIDValidity !== mailboxUIDValidity) throw new Error("MAILBOX_CHANGED")
    if (action === "read") {
      await session.command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`)
      return { ok: true, uidValidity: mailboxUIDValidity }
    }
    if (action === "delete") {
      await session.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`)
      await session.command("EXPUNGE")
      return { ok: true, uidValidity: mailboxUIDValidity }
    }
    throw new Error("未知 IMAP 邮箱操作")
  })
}

export async function handleQQImap(body) {
  return handleImap({ ...body, provider: "qq" })
}
