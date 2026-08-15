import type { MailMessage } from "./models"

type RequestInit = { method?: string; headers?: Record<string, string>; body?: string }
declare function fetch(url: string, init?: RequestInit): Promise<any>

function decodeAttribute(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    try { return String.fromCodePoint(point) } catch { return match }
  })
}

function safeHttpsUrl(value: string) {
  try {
    const url = new URL(decodeAttribute(value.trim()))
    return url.protocol === "https:" ? url.href : undefined
  } catch { return undefined }
}

export function unsubscribeFromHeaders(listHeader: string, postHeader: string) {
  const candidates = Array.from(listHeader.matchAll(/<([^>]+)>/g), match => match[1])
  if (!candidates.length && listHeader.trim()) candidates.push(...listHeader.split(",").map(item => item.trim()))
  const url = candidates.map(safeHttpsUrl).find(Boolean)
  if (!url) return undefined
  return {
    url,
    oneClick: /list-unsubscribe\s*=\s*one-click/i.test(postHeader),
  }
}

export function unsubscribeFromHtml(html: string) {
  const anchorPattern = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi
  let fallback: string | undefined
  for (const match of html.matchAll(anchorPattern)) {
    const href = safeHttpsUrl(match[2])
    if (!href) continue
    const label = decodeAttribute(match[3].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
    const signal = `${label} ${href}`
    if (/(?:取消订阅|退订|不再接收|unsubscribe|opt[ -]?out)/i.test(signal)) {
      if (/(?:取消订阅|退订|unsubscribe|opt[ -]?out)/i.test(label)) return { url: href, oneClick: false }
      fallback ??= href
    }
  }
  return fallback ? { url: fallback, oneClick: false } : undefined
}

export async function unsubscribeMessage(message: MailMessage) {
  if (!message.unsubscribeUrl) throw new Error("这封邮件没有提供可用的 HTTPS 退订地址")
  const url = safeHttpsUrl(message.unsubscribeUrl)
  if (!url) throw new Error("为保护账号安全，只支持 HTTPS 退订地址")
  const response = await fetch(url, message.unsubscribeOneClick ? {
    method: "POST",
    headers: {
      Accept: "text/html,application/json,*/*",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "List-Unsubscribe=One-Click",
  } : {
    method: "GET",
    headers: { Accept: "text/html,application/json,*/*" },
  })
  if (!response.ok) throw new Error(`退订请求失败（HTTP ${response.status ?? "未知"}）`)
  return message.unsubscribeOneClick
}
