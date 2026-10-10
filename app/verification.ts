const KEYWORD_REGEX = /(?:验证码|校验码|动态码|登录码|安全码|确认码|一次性密码|verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP|code\s+to\s+(?:log\s*in|sign\s*in)|(?:enter|use)\s+(?:the\s+)?(?:following\s+)?code)/i

function isValidCandidate(code: string, text: string): boolean {
  if (!code || !/\d/.test(code)) return false
  if (code.length < 4 || code.length > 8) return false

  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g")
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index
    const end = start + code.length

    const before = text.slice(Math.max(0, start - 25), start).trimEnd()
    const after = text.slice(end, end + 25).trimStart()

    // 1. Part of user greeting / recipient identifier:
    // e.g. "1085481057, 您好" or "1085481057，你好" or "1085481057@qq.com" or "尊敬的 1085481057"
    if (/^(?:[,，]\s*(?:您好|你好|hello|hi|先生|女士)|(?:\s*(?:您好|你好))|@)/i.test(after)) continue
    if (/(?:尊敬的|亲爱的|Dear|Hi|Hello|用户)\s*$/i.test(before)) continue

    // 2. Duration / expiration time:
    // e.g. "15 分钟" or "1800 秒" or "10 minutes"
    if (/^(?:分钟|秒|小时|天|minutes?|mins?|seconds?|secs?|hours?)/i.test(after)) continue

    // 3. Date / time fragment (connected with - or / or : to other digits):
    // e.g. "2026-10-05" or "14:00:00"
    if (/^\s*[-/:]\d/.test(after) || /\d[-/:]\s*$/.test(before)) continue

    return true
  }
  return false
}

export function extractVerificationCode(subject: string, body: string, serverCode?: string): string | undefined {
  if (serverCode && serverCode.trim()) {
    const sc = serverCode.trim()
    const escaped = sc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(`${subject}\n${body}`)) {
      return sc
    }
  }

  const combined = `${subject}\n${body}`
  if (!KEYWORD_REGEX.test(combined)) return undefined

  const highConfidencePatterns = [
    // 1. 验证码是/为/:/： [code]
    /(?:验证码|校验码|动态码|登录码|安全码|确认码|一次性密码)\s*(?:为|是|为[:：]?|是[:：]?|[:：])\s*['"“‘【\[(]?([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/gi,
    // 2. English: verification code is / : [code]
    /(?:verification|security|login|confirmation|one[- ]time)\s*(?:code|passcode|password|OTP)\s*(?:is\s*[:：]?|[:：])\s*['"“‘【\[(]?([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/gi,
    // 3. English: enter the following code / code to log in: [code]
    /(?:code\s+to\s+(?:log\s*in|sign\s*in)|(?:enter|use)\s+(?:the\s+)?(?:following\s+)?code)\s*[:：]?\s*['"“‘【\[(]?([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/gi,
    // 4. [code] 是您的/为您的验证码 or [code] is your verification code
    /(?<![A-Za-z0-9])([A-Za-z0-9]{4,8})\s*(?:(?:为|是)?(?:您的)?(?:邮箱|短信|登录|动态|安全)?(?:验证码|校验码|动态码|安全码|确认码|一次性密码)|is your (?:verification|security|login|one-time) code)/gi,
    // 5. Bracketed: 【123456】or [123456] when keyword is nearby
    /【([A-Za-z0-9]{4,8})】\s*(?:(?:为|是)?(?:您的)?(?:验证码|校验码|动态码|登录码|安全码|确认码)|[^\n]{0,10}(?:验证码|校验码|动态码|登录码|安全码|确认码))/gi,
    /(?:验证码|校验码|动态码|登录码|安全码|确认码)[^\n]{0,10}【([A-Za-z0-9]{4,8})】/gi,
  ]

  for (const pattern of highConfidencePatterns) {
    for (const text of [body, subject]) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const candidate = match[1]
        if (isValidCandidate(candidate, text)) return candidate
      }
    }
  }

  const mediumConfidencePatterns = [
    // Keyword followed on same or next line by code
    /(?:验证码|校验码|动态码|登录码|安全码|确认码|一次性密码|verification\s*code|security\s*code|login\s*code|passcode|one[- ]time\s*(?:password|code)|OTP)[^A-Za-z0-9\n]{0,15}(?:\r?\n\s*)?['"“‘【\[(]?([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/gi,
  ]

  for (const pattern of mediumConfidencePatterns) {
    for (const text of [body, subject]) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const candidate = match[1]
        if (isValidCandidate(candidate, text)) return candidate
      }
    }
  }

  return undefined
}
