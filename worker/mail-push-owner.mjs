import { handleBackgroundPush, handleCloudMailWebhook, handleForwardedEmail, handleMicrosoftWebhook, runBackgroundChecks, drainPendingPushes, nextPushWake } from "./background-push.mjs"
import { durableStore } from "./state-store.mjs"

const CONFIG_KEY = "mail-push:owner-config:v2"
const PUSH_KEY_KEY = "mail-push:owner-push-key:v1"
const MIGRATION_KEY = "internal:migration:kv-to-do:v1"
const CLEANUP_KEY = "internal:cleanup:last:v1"
const CHECK_INTERVAL_MS = 3 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  })
}

export class MailPushOwner {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.store = durableStore(state.storage)
    this.taskQueue = Promise.resolve()
    this.microsoftSyncQueued = false
    this.ready = state.blockConcurrencyWhile(async () => {
      await this.migrateLegacyKV()
      await this.ensureAlarm()
    })
  }

  async migrateLegacyKV() {
    if (await this.state.storage.get(MIGRATION_KEY)) return
    if (await this.store.get(CONFIG_KEY)) {
      await this.state.storage.put(MIGRATION_KEY, { completedAt: new Date().toISOString(), result: "local-config" })
      return
    }
    const legacy = this.env.MAIL_PUSH_STORE_LEGACY
    if (!legacy) return
    const entries = {}
    for (const key of [CONFIG_KEY, PUSH_KEY_KEY]) {
      const value = await legacy.get(key)
      if (value !== null) entries[key] = { value: String(value), expiresAt: 0 }
    }
    if (!entries[CONFIG_KEY]) return
    entries[MIGRATION_KEY] = { completedAt: new Date().toISOString(), result: "imported" }
    await this.state.storage.put(entries)
  }

  async ensureAlarm(urgent = false) {
    if (!await this.store.get(CONFIG_KEY)) return false
    const alarm = await this.state.storage.getAlarm()
    const queued = await nextPushWake(this.localEnv())
    const target = Math.min(Date.now() + (urgent ? 1000 : CHECK_INTERVAL_MS), queued || Infinity)
    if (alarm === null || alarm > target) await this.state.storage.setAlarm(target)
    return true
  }

  async cleanupExpired() {
    const lastCleanup = Number(await this.state.storage.get(CLEANUP_KEY) || 0)
    if (Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) return
    const records = await this.state.storage.list()
    const expired = []
    const now = Date.now()
    for (const [key, record] of records) {
      if (record?.expiresAt && record.expiresAt <= now) expired.push(key)
    }
    if (expired.length) await this.state.storage.delete(expired)
    await this.state.storage.put(CLEANUP_KEY, now)
  }

  localEnv() {
    return { ...this.env, MAIL_PUSH_STORE: this.store, MAIL_PUSH_WAKE: async () => {
      const target = Date.now() + 1000
      const alarm = await this.state.storage.getAlarm()
      if (alarm === null || alarm > target) await this.state.storage.setAlarm(target)
    } }
  }

  runExclusive(task) {
    const result = this.taskQueue.then(task, task)
    this.taskQueue = result.catch(() => {})
    return result
  }

  scheduleMicrosoftSync(task) {
    if (this.microsoftSyncQueued) return
    this.microsoftSyncQueued = true
    this.state.waitUntil(this.runExclusive(async () => {
      try { await task() }
      finally { this.microsoftSyncQueued = false }
    }))
  }

  async fetch(request) {
    await this.ready
    const pathname = new URL(request.url).pathname
    if (pathname === "/v1/push/config" || pathname === "/v1/push/test") {
      return this.runExclusive(async () => {
        const response = await handleBackgroundPush(request, this.localEnv(), pathname, json)
        if (pathname === "/v1/push/config" && response?.ok) {
          if (request.method === "DELETE") await this.state.storage.deleteAlarm()
          else if (request.method === "PUT") await this.ensureAlarm(true)
        }
        return response ?? new Response(null, { status: 405 })
      })
    }
    if (pathname === "/internal/email") {
      return this.runExclusive(async () => {
        const raw = await request.arrayBuffer()
        const requestURL = new URL(request.url)
        const headerBytes = new Uint8Array(raw).subarray(0, Math.min(raw.byteLength, 64 * 1024))
        const headerText = new TextDecoder().decode(headerBytes).split(/\r?\n\r?\n/, 1)[0]
        const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ")
        const headers = new Headers()
        for (const line of unfolded.split(/\r?\n/)) {
          const separator = line.indexOf(":")
          if (separator > 0) headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
        }
        const message = {
          headers,
          from: requestURL.searchParams.get("from") || "",
          to: requestURL.searchParams.get("to") || "",
          raw,
          verificationAction: undefined,
          rejectReason: "",
          setReject(reason) { this.rejectReason = String(reason || "Rejected") },
        }
        await handleForwardedEmail(message, this.localEnv())
        return json({ rejectReason: message.rejectReason || "" })
      })
    }
    if (pathname === "/v1/webhooks/cloud-mail") return this.runExclusive(() => handleCloudMailWebhook(request, this.localEnv()))
    if (pathname === "/v1/webhooks/microsoft/mail") {
      return this.runExclusive(() => handleMicrosoftWebhook(request, this.localEnv(), {
        schedule: async () => this.ensureAlarm(true),
      }))
    }
    if (request.method !== "POST") return new Response(null, { status: 405 })
    if (pathname === "/internal/check") {
      return this.runExclusive(async () => {
        await runBackgroundChecks(this.localEnv())
        await this.cleanupExpired()
        await this.ensureAlarm()
        return new Response(null, { status: 204 })
      })
    }
    if (pathname === "/internal/ensure-alarm") {
      return this.runExclusive(async () => json({ scheduled: await this.ensureAlarm() }))
    }
    return new Response(null, { status: 404 })
  }

  async alarm() {
    await this.ready
    return this.runExclusive(async () => {
      try {
        await drainPendingPushes(this.localEnv())
        await runBackgroundChecks(this.localEnv())
        await this.cleanupExpired()
      } finally {
        await this.ensureAlarm()
      }
    })
  }
}
