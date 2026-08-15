declare function fetch(url: string, init?: any): Promise<any>

const PUSH_KEYCHAIN_KEY = "cloud_mail_manager.remote_push_subscription_key.v1"
const PUSH_ENDPOINT = "https://push.scripting.fun/push"

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
      icon: "envelope.badge.fill",
      iconColor: "systemBlue",
      sound: "default",
      interruptionLevel: "active",
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
