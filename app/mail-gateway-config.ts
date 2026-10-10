// Isolated gateway for QQ and NetEase IMAP. Gmail OAuth remains on its production relay.
export const MAIL_GATEWAY = {
  origin: "https://throbbing-dream-aaa1.1085481057.workers.dev",
  imapEnabled: true,
} as const

export function imapGatewayConfigured() {
  return MAIL_GATEWAY.imapEnabled && /^https:\/\//i.test(MAIL_GATEWAY.origin)
}
