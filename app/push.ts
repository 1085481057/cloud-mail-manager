import { Notification } from "scripting"

declare function fetch(url: string, init?: any): Promise<any>

const PUSH_KEYCHAIN_KEY = "cloud_mail_manager.remote_push_subscription_key.v1"
const PUSH_ENDPOINT = "https://push.scripting.fun/push"
export const CLOUD_MAIL_ICON_URL = "https://red-sea-7bc7.1085481057.workers.dev/icons/cloudmail.png"

export function buildMailActionUrl(params: {
  accountId?: string
  messageId?: string
  from?: string
  subject?: string
  preview?: string
  date?: string
  code?: string
}) {
  const query = new URLSearchParams()
  if (params.accountId) query.set("accountId", params.accountId)
  if (params.messageId) query.set("messageId", params.messageId)
  if (params.from) query.set("from", params.from.slice(0, 100))
  if (params.subject) query.set("subject", params.subject.slice(0, 120))
  if (params.preview) query.set("preview", params.preview.slice(0, 200))
  if (params.date) query.set("date", params.date)
  if (params.code) query.set("code", params.code)
  const qs = query.toString()
  return qs ? `scripting://run/云邮管家?${qs}` : "scripting://run/云邮管家"
}

export function saveRemotePushKey(key: string) {
  const normalized = key.trim().replace(/^Bearer\s+/i, "")
  if (normalized.length < 16 || /\s/.test(normalized)) throw new Error("推送 API Key 格式无效")
  const saved = Keychain.set(PUSH_KEYCHAIN_KEY, normalized, { accessibility: "unlocked_this_device" })
  if (!saved) throw new Error("推送 API Key 保存失败")
}

export function hasRemotePushKey() {
  return Boolean(Keychain.get(PUSH_KEYCHAIN_KEY))
}

export function removeRemotePushKey() {
  Keychain.remove(PUSH_KEYCHAIN_KEY)
}

export async function sendRemotePush(input: {
  title: string
  body: string
  threadId?: string
  badge?: number
  action?: string
  icon?: string
  iconColor?: string
  image?: string
}) {
  const key = Keychain.get(PUSH_KEYCHAIN_KEY)
  if (!key) throw new Error("尚未绑定推送 API Key")
  const response = await fetch(PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      threadId: input.threadId ?? "cloud-mail-manager",
      badge: input.badge,
      action: input.action ?? "scripting://run/云邮管家",
      icon: input.icon ?? CLOUD_MAIL_ICON_URL,
      iconColor: input.iconColor ?? "#0A84FF",
      ...(input.image ? { image: input.image } : {}),
      sound: "default",
      interruptionLevel: "time-sensitive",
    }),
  })
  let payload: any = null
  try { payload = await response.json() } catch {}
  if (!response.ok || payload?.ok === false) {
    const code = String(payload?.error?.code ?? payload?.code ?? `HTTP_${response.status}`)
    throw new Error(`推送服务拒绝请求（${code}）`)
  }
  return {
    targetDevices: Number(payload?.data?.target_devices ?? 0),
    remaining: typeof payload?.data?.remaining === "number" ? payload.data.remaining : undefined,
  }
}

export async function sendLocalNotification(input: {
  title: string
  subtitle?: string
  body?: string
  sound?: string
  interruptionLevel?: "active" | "timeSensitive" | "passive" | "critical"
  mailMeta?: {
    accountId?: string
    messageId?: string
    from?: string
    subject?: string
    preview?: string
    date?: string
    code?: string
  }
}) {
  const iconPath = "/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/云邮管家/icons/cloudmail.png"
  let iconImageData: any = null
  try {
    iconImageData = Data.fromFile(iconPath)
  } catch {}

  const actionUrl = input.mailMeta ? buildMailActionUrl(input.mailMeta) : undefined

  return await Notification.schedule({
    title: input.title,
    subtitle: input.subtitle,
    body: input.body,
    iconImageData,
    sound: input.sound ?? "default",
    interruptionLevel: (input.interruptionLevel as any) ?? "timeSensitive",
    userInfo: input.mailMeta ? { ...input.mailMeta } : undefined,
    tapAction: actionUrl ? { type: "openURL", url: actionUrl } : undefined,
  })
}
