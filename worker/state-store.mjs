function storedRecord(value, options = {}) {
  const ttl = Number(options.expirationTtl || 0)
  const expiration = Number(options.expiration || 0)
  return {
    value: String(value),
    expiresAt: expiration > 0 ? expiration * 1000 : ttl > 0 ? Date.now() + ttl * 1000 : 0,
  }
}

export function durableStore(storage) {
  return {
    async get(key) {
      const record = await storage.get(String(key))
      if (!record) return null
      if (record.expiresAt && record.expiresAt <= Date.now()) {
        await storage.delete(String(key))
        return null
      }
      return String(record.value)
    },
    async put(key, value, options = {}) {
      await storage.put(String(key), storedRecord(value, options))
    },
    async putMany(entries) {
      const values = {}
      for (const [key, entry] of Object.entries(entries)) {
        values[String(key)] = entry?.options ? storedRecord(entry.value, entry.options) : entry
      }
      await storage.put(values)
    },
    async delete(key) {
      await storage.delete(String(key))
    },
    async list(prefix = "") {
      const entries = await storage.list({ prefix: String(prefix) })
      const result = []
      const now = Date.now()
      for (const [key, record] of entries) {
        if (!record) continue
        if (record.expiresAt && record.expiresAt <= now) {
          await storage.delete(String(key))
          continue
        }
        result.push({ key: String(key), value: String(record.value) })
      }
      return result
    },
  }
}

export function ownerStub(env) {
  if (!env.MAIL_PUSH_OWNER) throw new Error("MAIL_PUSH_OWNER binding is missing")
  const id = env.MAIL_PUSH_OWNER.idFromName("owner")
  return env.MAIL_PUSH_OWNER.get(id)
}

