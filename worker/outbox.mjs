const OUTBOX_PREFIX = "mail-push:outbox:"
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
const RETRY_BASE_MS = 30 * 1000
const RETRY_MAX_MS = 60 * 60 * 1000
const MAX_DRAIN_LIMIT = 10
const MAX_ATTEMPTS = 10

function textError(error) {
  return String(error?.message ?? error).slice(0, 240)
}

function parseJSON(value) {
  if (value === null || value === undefined) return null
  if (typeof value === "object") return value
  try { return JSON.parse(String(value)) } catch { return null }
}

function listEntries(value) {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map(item => Array.isArray(item)
      ? { key: String(item[0]), value: item[1] }
      : { key: String(item.key ?? ""), value: item.value }).filter(item => item.key)
  }
  if (value instanceof Map) return [...value].map(([key, item]) => ({ key: String(key), value: item }))
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => ({ key, value: item }))
  return []
}

function queueKey(digest) {
  return `${OUTBOX_PREFIX}${digest}`
}

function asTime(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function dueAt(task) {
  return asTime(task?.nextAttemptAt, 0)
}

function createdAt(task, entryKey) {
  const value = asTime(task?.createdAt, 0)
  return value || Number.MAX_SAFE_INTEGER
}

function sentTTL(task) {
  const value = Number(task?.sentTtl ?? task?.ttl ?? DEFAULT_TTL_SECONDS)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TTL_SECONDS
}

function accountScopeExists(record, scope) {
  if (!scope) return true
  const accounts = Array.isArray(record?.accounts) ? record.accounts : []
  return accounts.some(account => `${account?.provider ?? ""}:${account?.id ?? ""}:${account?.address ?? ""}` === scope)
}

function retryAfterMs(error, now) {
  if (typeof error?.retryAfterMs === "number") return Math.max(0,error.retryAfterMs)
  const direct = error?.retryAfter
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct >= 1000 ? direct : direct * 1000
  }
  const response = error?.response
  const headers = response?.headers
  let value = error?.headers?.get?.("Retry-After") ?? error?.headers?.["Retry-After"]
  if (value === undefined) value = headers?.get?.("Retry-After") ?? headers?.["Retry-After"]
  if (value === undefined) return 0
  const seconds = Number(String(value).trim())
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(String(value))
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}

function retryDelay(attempts, error, now) {
  const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)))
  return Math.min(86400000, Math.max(exponential, retryAfterMs(error, now)))
}

function safeLog(message, error) {
  try { console.error(message, textError(error)) } catch {}
}

export function createOutbox({ seal, open, sendPush, digestId, activePushKey }) {
  if (typeof seal !== "function" || typeof open !== "function" || typeof sendPush !== "function" || typeof digestId !== "function" || typeof activePushKey !== "function") {
    throw new TypeError("createOutbox requires seal, open, sendPush, digestId and activePushKey")
  }

  async function entries(env) {
    const store = env?.MAIL_PUSH_STORE
    if (!store || typeof store.list !== "function") return []
    return listEntries(await store.list(OUTBOX_PREFIX))
  }

  async function readSent(store, key) {
    if (!key || typeof store?.get !== "function") return ""
    const value = await store.get(String(key))
    return String(parseJSON(value)?.state ?? "")
  }

  async function saveTask(env, key, task) {
    const encrypted = await seal(task, env)
    // Never pass expirationTtl for an outbox item: queued work must not vanish.
    await env.MAIL_PUSH_STORE.put(key, encrypted)
  }

  async function enqueue(env, key, message, ttl = DEFAULT_TTL_SECONDS) {
    const store = env?.MAIL_PUSH_STORE
    if (!store || typeof store.get !== "function" || typeof store.put !== "function") throw new Error("MAIL_PUSH_STORE is missing")
    const deliveryKey = String(key)
    if (!deliveryKey) throw new Error("delivery key is missing")

    // Wake must be requested before this operation writes anything.
    if (typeof env.MAIL_PUSH_WAKE === "function") await env.MAIL_PUSH_WAKE()

    if (await readSent(store, deliveryKey) === "sent") return { accepted: false, duplicate: true, state: "sent" }

    const taskKey = queueKey(await digestId(deliveryKey))
    const existing = await store.get(taskKey)
    if (existing !== null && existing !== undefined) {
      const existingTask = parseJSON(await open(existing, env))
      return { accepted: true, duplicate: false, queued: true, state: String(existingTask?.state ?? "queued"), key: taskKey }
    }

    const now = Date.now()
    const task = {
      state: "queued",
      deliveryKey,
      message,
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: now,
      sentTtl: Number.isFinite(Number(ttl)) && Number(ttl) > 0 ? Math.floor(Number(ttl)) : DEFAULT_TTL_SECONDS,
    }
    await saveTask(env, taskKey, task)
    return { accepted: true, duplicate: false, queued: true, state: "queued", key: taskKey }
  }

  async function markDiagnostic(env, entryKey, task, fields) {
    try {
      await saveTask(env, entryKey, { ...task, nextAttemptAt: Date.now()+30000, ...fields })
      return true
    } catch (error) {
      safeLog("OUTBOX_DIAGNOSTIC_WRITE_FAILED", error)
      return false
    }
  }

  async function drain(env, record, limit = MAX_DRAIN_LIMIT) {
    const store = env?.MAIL_PUSH_STORE
    if (!store || typeof store.list !== "function") return 0
    const budget = Math.min(MAX_DRAIN_LIMIT, Math.max(0, Number(limit) || 0))
    if (!budget) return 0

    const now = Date.now()
    const candidates = []
    for (const entry of await entries(env)) {
      let task
      try {
        task = parseJSON(await open(entry.value, env))
      } catch (error) {
        // An unreadable item is retained for diagnosis and must not cause a hot loop.
        safeLog("OUTBOX_DECRYPT_FAILED", error)
        continue
      }
      if (!task || task.state !== "queued") continue
      candidates.push({ entry, task })
    }
    candidates.sort((left, right) => {
      const dueDifference = dueAt(left.task) - dueAt(right.task)
      if (dueDifference) return dueDifference
      const createdDifference = createdAt(left.task, left.entry.key) - createdAt(right.task, right.entry.key)
      if (createdDifference) return createdDifference
      return left.entry.key.localeCompare(right.entry.key)
    })

    let processed = 0
    for (const { entry, task } of candidates) {
      if (processed >= budget) break
      const current = Date.now()
      if (dueAt(task) > current) continue
      processed++

      const expiration = asTime(task.expiresAt, 0)
      if (expiration > 0 && expiration <= current) {
        await markDiagnostic(env, entry.key, task, {
          state: "expired",
          expiredAt: new Date(current).toISOString(),
          lastError: "OUTBOX_EXPIRED",
        })
        continue
      }

      const scope = String(task?.message?.accountScope ?? "")
      if (scope && !accountScopeExists(record, scope)) {
        await markDiagnostic(env, entry.key, task, {
          state: "cancelled",
          cancelledAt: new Date(current).toISOString(),
          lastError: "ACCOUNT_REMOVED",
          diagnostic: { reason: "accountScope no longer exists", accountScope: scope },
        })
        continue
      }

      let deliveryState
      try {
        deliveryState = await readSent(store, task.deliveryKey)
      } catch (error) {
        await markDiagnostic(env, entry.key, task, { lastStorageError: textError(error), lastStorageErrorAt: new Date(current).toISOString() })
        continue
      }
      if (deliveryState === "sent") {
        try { await store.delete(entry.key) } catch (error) { safeLog("OUTBOX_DELETE_AFTER_SENT_FAILED", error) }
        continue
      }

      let pushKey
      try {
        pushKey = await activePushKey(record, env)
      } catch (error) {
        await markDiagnostic(env, entry.key, task, { lastStorageError: textError(error), lastStorageErrorAt: new Date(current).toISOString() })
        continue
      }

      try {
        await sendPush(pushKey, task.message)
      } catch (error) {
        const attempts = Math.min(MAX_ATTEMPTS, Math.max(0, Number(task.attempts) || 0) + 1)
        const retryAt = Date.now() + retryDelay(attempts, error, Date.now())
        await markDiagnostic(env, entry.key, task, {
          state: "queued",
          attempts,
          nextAttemptAt: retryAt,
          lastError: textError(error),
          lastErrorAt: new Date().toISOString(),
          retryAfterMs: retryAfterMs(error, Date.now()) || undefined,
        })
        continue
      }

      // The sent marker is the commit point. Only remove the queue item after it is durable.
      try {
        await store.put(task.deliveryKey, JSON.stringify({ state: "sent", sentAt: new Date().toISOString() }), { expirationTtl: sentTTL(task) })
      } catch (error) {
        // This is a storage failure, not a network failure: do not increase attempts or back off.
        await markDiagnostic(env, entry.key, task, {
          lastStorageError: textError(error),
          lastStorageErrorAt: new Date().toISOString(),
          diagnostic: { reason: "sent marker write failed; queue retained" },
        })
        continue
      }

      try {
        await store.delete(entry.key)
      } catch (error) {
        // A durable sent marker makes the next drain delete this item without replaying it.
        safeLog("OUTBOX_DELETE_AFTER_SENT_FAILED", error)
      }
    }
    return processed
  }

  async function nextWake(env) {
    const now = Date.now()
    let next = null
    for (const entry of await entries(env)) {
      let task
      try { task = parseJSON(await open(entry.value, env)) } catch { continue }
      if (!task || task.state !== "queued") continue
      const due = dueAt(task)
      const candidate = due > now ? due : now + 1000
      if (next === null || candidate < next) next = candidate
    }
    return next
  }

  return { enqueue, drain, nextWake }
}

export { OUTBOX_PREFIX }
