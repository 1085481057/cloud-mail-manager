export type Provider = "cloudmail" | "gmail" | "microsoft" | "qq" | "netease163" | "netease126" | "yeah"

export type MailAccount = {
  id: string
  provider: Provider
  name: string
  address: string
  baseUrl?: string
  inboxPath?: string
  remoteAccountId?: number
  allReceive?: number
  r2Domain?: string
  oauthRelayUrl?: string
  gmailHistoryId?: string
  qqBeforeUID?: string
  qqPaginationEnded?: boolean
  deletedIds?: string[]
  syncState?: { cursor?: string; ended?: boolean; uidValidity?: string }
  enabled: boolean
}

export type GmailOAuthSecret = {
  version: 1
  relaySecret: string
  credential?: OAuthCredential
}

export type CloudMailRemoteAccount = {
  accountId: number
  email: string
  name: string
  status: number
  latestEmailTime?: string | null
  createTime?: string | null
  allReceive: number
  sort: number
}

export type CloudMailWebsiteConfig = {
  domainList: string[]
  addVerifyOpen: boolean
  addEmailVerify?: number
  r2Domain?: string
}

export type MailMessage = {
  id: string
  accountId: string
  provider: Provider
  from: string
  to?: string
  subject: string
  preview: string
  body: string
  date: string
  unread: boolean
  verificationCode?: string
  html?: string
  attachments?: MailAttachment[]
  threadId?: string
  historyId?: string
  labelIds?: string[]
  unsubscribeUrl?: string
  unsubscribeOneClick?: boolean
  contentCached?: boolean
  isPlaceholder?: boolean
}

export type MailAttachment = {
  id: string
  filename: string
  mimeType: string
  size: number
  key: string
  url?: string
}

export const providerName = (provider: Provider) =>
  provider === "cloudmail" ? "Cloud Mail" : provider === "gmail" ? "Gmail" : provider === "microsoft" ? "Microsoft 365" : provider === "qq" ? "QQ 邮箱" : provider === "netease163" ? "网易 163" : provider === "netease126" ? "网易 126" : "Yeah 邮箱"

export const providerIcon = (provider: Provider) =>
  provider === "cloudmail" ? "cloud.fill" : provider === "gmail" ? "g.circle.fill" : provider === "microsoft" ? "m.circle.fill" : provider === "qq" ? "q.circle.fill" : "envelope.fill"

export const providerColor = (provider: Provider) =>
  provider === "cloudmail" ? "systemGreen" : provider === "gmail" ? "systemRed" : provider === "microsoft" ? "systemBlue" : provider === "qq" ? "systemBlue" : "systemOrange"

export function stripEmailSignature(text: string): string {
  if (!text) return ""
  return text
    .replace(/(?:^|\n|\s*)(?:--\s*(?:\r?\n|$)|——\s*(?:\r?\n|$))?(?:发自我的\s*(?:iPhone|iPad|手机|移动设备)|从我的\s*(?:iPhone|iPad|手机)\s*发[送件]|Sent from my\s*(?:iPhone|iPad|mobile|Galaxy|Android)|Sent from Mail for Windows|发自\s*(?:网易邮箱大师|网易企业邮|QQ邮箱手机客户端)|使用\s*QQ邮箱\s*发送)[\s\S]*$/i, "")
    .trim()
}

/**
 * 智能判定邮件候选对象与目标特征（ID、主题、发件人）是否匹配
 * 特别兼顾“无主题”/“（无主题）”/空主题的等价归一化，发件人昵称/邮箱模糊比对与临时占位 ID 映射
 */
export function isMessageMatch(
  candidate: { id?: string; emailId?: string | number; subject?: string; from?: string; name?: string; sendEmail?: string; date?: string | Date; createTime?: string; preview?: string },
  targetId?: string,
  targetSubject?: string,
  targetFrom?: string,
  targetDate?: string | Date,
  targetPreview?: string
): boolean {
  const candidateId = String(candidate.emailId ?? candidate.id ?? "")
  // 1. 真实 ID 精确匹配
  if (targetId && candidateId && candidateId === targetId) {
    return true
  }

  // 日期防误判：如果双方都有日期，且相差超过 12 小时，绝对不是同一封邮件
  if (targetDate && (candidate.date || candidate.createTime)) {
    const tTime = new Date(targetDate).getTime()
    const cTime = new Date(candidate.date ?? candidate.createTime!).getTime()
    if (Number.isFinite(tTime) && Number.isFinite(cTime) && Math.abs(tTime - cTime) > 12 * 3600 * 1000) {
      return false
    }
  }

  // 归一化主题函数
  const normalizeSubject = (s?: string) => {
    if (!s) return ""
    return s
      .replace(/^[\[\(【（]?(?:Re|Fwd|回复|转发)[:：]\s*/i, "")
      .replace(/[…\.]+$/, "")
      .trim()
  }

  const isNoSubject = (s?: string) => {
    const norm = normalizeSubject(s)
    return !norm || norm === "无主题" || norm === "（无主题）" || norm === "(无主题)" || norm.toLowerCase() === "no subject"
  }

  const normTargetSubject = normalizeSubject(targetSubject)
  const normCandSubject = normalizeSubject(candidate.subject)
  const targetIsNoSubject = isNoSubject(targetSubject)
  const candIsNoSubject = isNoSubject(candidate.subject)

  // 归一化发件人函数：提取名字和纯邮箱
  const extractFromParts = (fromStr?: string, name?: string, sendEmail?: string) => {
    const raw = [fromStr, name, sendEmail].filter(Boolean).join(" ")
    const emailMatch = raw.match(/[\w.+-]+@[\w.-]+\.\w+/)
    const email = emailMatch ? emailMatch[0].toLowerCase() : ""
    const cleanName = raw.replace(/<[^>]+>/g, "").replace(/[\w.+-]+@[\w.-]+\.\w+/g, "").trim().toLowerCase()
    return { email, name: cleanName }
  }

  const targetParts = extractFromParts(targetFrom)
  const candParts = extractFromParts(candidate.from, candidate.name, candidate.sendEmail)

  const fromMatches = Boolean(
    (targetParts.email && candParts.email && (targetParts.email === candParts.email || candParts.email.includes(targetParts.email) || targetParts.email.includes(candParts.email))) ||
    (targetParts.name && candParts.name && (candParts.name.includes(targetParts.name) || targetParts.name.includes(candParts.name)))
  )

  // 2. 双方都是“无主题”：
  if (targetIsNoSubject && candIsNoSubject) {
    if (fromMatches || !targetFrom) {
      // 双方都无主题且发件人一致时，如果是同一人在短时间内连发的不同邮件，很容易误判。
      // 如果提供了预览文本摘要，要求摘要也必须有一定程度的重合。
      if (targetPreview && candidate.preview) {
        const cleanTargetPreview = targetPreview.replace(/通知摘要预览/g, "").trim().replace(/\s+/g, "")
        const cleanCandPreview = candidate.preview.replace(/通知摘要预览/g, "").trim().replace(/\s+/g, "")
        
        if (cleanTargetPreview && cleanCandPreview) {
          const t10 = cleanTargetPreview.slice(0, 10)
          const c10 = cleanCandPreview.slice(0, 10)
          if (!c10.includes(t10) && !t10.includes(c10)) {
            // 如果预览完全不包含，但在极端情况下，网易由于解析 HTML 和 CF 解析不同导致正文差别过大
            // 我们通过时间差来容错：如果这两封没主题的信，时间差在 3 分钟以内，强制认定为同一封！
            const tTime = new Date(targetDate || "").getTime()
            const cTime = new Date(candidate.date || "").getTime()
            if (Number.isFinite(tTime) && Number.isFinite(cTime) && Math.abs(tTime - cTime) < 3 * 60 * 1000) {
              return true
            }
            return false
          }
        } else if (cleanCandPreview && !cleanTargetPreview) {
          // 占位符没拉到正文，候选人有正文，这种不能算匹配失败
        }
      }
      return true
    }
  }

  // 3. 双方都有真实主题内容：
  if (!targetIsNoSubject && !candIsNoSubject) {
    const subjectMatches = normCandSubject === normTargetSubject ||
      normCandSubject.startsWith(normTargetSubject) ||
      normTargetSubject.startsWith(normCandSubject) ||
      normCandSubject.includes(normTargetSubject) ||
      normTargetSubject.includes(normCandSubject)
      
    if (subjectMatches) {
      // 如果主题比较长（具备唯一特征），或者发件人匹配，或者目标未给出发件人，则直接认定匹配
      if (normTargetSubject.length >= 8 || fromMatches || !targetFrom) {
        return true
      }
    }
  }

  return false
}

