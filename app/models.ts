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
