// Discovery only. Persist messages in an idempotent outbox BEFORE applying the
// returned checkpoint (ideally in the same storage transaction). Never commit
// a checkpoint if discovery or outbox insertion fails. See mailbox-sync.md.
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
const GRAPH = "https://graph.microsoft.com/v1.0/me"
const SELECT = "id,subject,from,bodyPreview,internetMessageId,receivedDateTime"

function fail(code) { throw new Error(code) }
function timestamp(value, code) {
  const result = typeof value === "number" ? value : Date.parse(value || "")
  if (!Number.isFinite(result) || result < 0) fail(code)
  return result
}
function graphLink(value) {
  let url
  try { url = new URL(value) } catch { fail("MICROSOFT_INVALID_NEXT_LINK") }
  if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash) fail("MICROSOFT_INVALID_NEXT_LINK")
  return url.href
}
async function request(url, token) {
  // Do not follow a redirect carrying a bearer token to an untrusted origin.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  let response
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "manual",
    })
  } finally { clearTimeout(timer) }
  if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
    fail("MAILBOX_UNEXPECTED_REDIRECT")
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const error = new Error(`MAILBOX_HTTP_${response.status}`)
    error.status = response.status
    error.providerCode = String(body?.error?.code || "")
    error.providerMessage = String(body?.error?.message || "")
    throw error
  }
  const value = await response.json()
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MAILBOX_INVALID_RESPONSE")
  return value
}
function header(value, name) {
  return String(value?.payload?.headers?.find(item => String(item?.name).toLowerCase() === name)?.value || "")
}
async function detail(provider, id, token) {
  const url = provider === "gmail"
    ? `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`
    : `${GRAPH}/messages/${encodeURIComponent(id)}?$select=${SELECT}`
  let value
  try { value = await request(url, token) } catch (error) {
    if (error.status === 404) return null
    throw error
  }
  if (value.id !== id) fail("MAILBOX_INVALID_MESSAGE_ID")
  const receivedAt = provider === "gmail"
    ? timestamp(value.internalDate === undefined ? NaN : Number(value.internalDate), "GMAIL_INVALID_RECEIVED_TIME")
    : timestamp(value.receivedDateTime, "MICROSOFT_INVALID_RECEIVED_TIME")
  return provider === "gmail"
    ? { id, from: header(value, "from"), subject: header(value, "subject"), preview: String(value.snippet || ""), messageId: header(value, "message-id"), receivedAt }
    : { id, from: String(value.from?.emailAddress?.name || value.from?.emailAddress?.address || ""), subject: String(value.subject || ""), preview: String(value.bodyPreview || ""), messageId: String(value.internetMessageId || ""), receivedAt }
}
function fresh(provider, boundary, excludeId = "") {
  return { version: 1, provider, mode: provider === "gmail" ? "gmail-scan" : "ms-delta", boundary, excludeId, pendingIds: [], nextPageToken: null, pageLoaded: false, cycleStartedAt: null, historyId: null, scanHistoryId: null, deltaLink: null, finalCursor: null }
}
function expired(error, state) {
  if (state.provider === "microsoft") {
    return error.status === 410 || ["syncStateNotFound", "InvalidDeltaToken", "ResyncRequired", "ErrorInvalidSyncStateData"].includes(error.providerCode)
  }
  return (state.mode === "gmail-history" && error.status === 404) ||
    (Boolean(state.nextPageToken) && error.status === 400 && /page.?token/i.test(error.providerMessage) && /invalid|expired/i.test(error.providerMessage))
}
function ids(items) {
  if (!Array.isArray(items)) fail("MAILBOX_INVALID_PAGE")
  return [...new Set(items.map(item => {
    if (typeof item?.id !== "string" || !item.id) fail("MAILBOX_INVALID_MESSAGE_ID")
    return item.id
  }))]
}
function pageToken(value) {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") fail("MAILBOX_INVALID_PAGE_TOKEN")
  return value
}
function historyID(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) fail("GMAIL_INVALID_HISTORY_ID")
  return value
}

/**
 * At most ONE list/history/delta page request and min(budget, 20) message
 * detail requests per call (including a legacy anchor). Profile is not a page.
 * account is immutable; checkpoint is JSON-serializable and shallow-assignable.
 * more means call again soon, not that a returned message necessarily exists.
 */
export async function discoverMessages(account, accessToken, budget = 20) {
  const provider = account?.provider
  if (!["gmail", "microsoft"].includes(provider)) fail("UNSUPPORTED_PROVIDER")
  if (!accessToken) fail("MAILBOX_ACCESS_TOKEN_REQUIRED")
  if (!Number.isFinite(budget) || budget < 1) fail("MAILBOX_INVALID_BUDGET")
  let remaining = Math.min(20, Math.floor(budget))
  let state
  if (account.mailboxSync != null) {
    state = JSON.parse(JSON.stringify(account.mailboxSync))
    if (state.version !== 1 || state.provider !== provider || !Array.isArray(state.pendingIds) ||
        !(provider === "gmail" ? ["gmail-scan", "gmail-history"] : ["ms-delta"]).includes(state.mode)) fail("MAILBOX_INVALID_CHECKPOINT")
    timestamp(state.boundary, "MAILBOX_INVALID_BOUNDARY")
    ids(state.pendingIds.map(id => ({ id })))
    if (provider === "microsoft") {
      for (const link of [state.nextPageToken, state.deltaLink, state.finalCursor]) if (link) graphLink(link)
    }
  } else {
    let boundary
    let excludeId = ""
    if (account.newestId) {
      remaining--
      const anchor = await detail(provider, String(account.newestId), accessToken)
      if (anchor) {
        boundary = anchor.receivedAt
        excludeId = anchor.id
      } else if (account.lastSuccessfulSyncAt != null) {
        boundary = timestamp(account.lastSuccessfulSyncAt, "MAILBOX_INVALID_LAST_SYNC_TIME")
      } else fail("MAILBOX_LEGACY_ANCHOR_DELETED_REQUIRES_BOUNDARY")
    } else if (account.lastSuccessfulSyncAt != null) {
      boundary = timestamp(account.lastSuccessfulSyncAt, "MAILBOX_INVALID_LAST_SYNC_TIME")
    } else {
      boundary = timestamp(account.pushEnabledAt, "MAILBOX_PUSH_ENABLED_AT_REQUIRED")
    }
    // Never send pre-enable mail if an explicit enable time is also available.
    if (account.pushEnabledAt != null) boundary = Math.max(boundary, timestamp(account.pushEnabledAt, "MAILBOX_INVALID_PUSH_ENABLED_AT"))
    state = fresh(provider, boundary, excludeId)
  }
  const checkpoint = { mailboxSync: state, newestId: "" }
  const messages = []
  const result = more => ({ messages, checkpoint, more })
  if (state.cycleStartedAt === null) state.cycleStartedAt = Date.now()

  // Drain a persisted page before fetching any further page.
  if (!state.pageLoaded && !state.pendingIds.length) {
    let url
    if (provider === "gmail") {
      if (state.mode === "gmail-scan") {
        // Capture BEFORE scanning so concurrent arrivals are recovered by history.
        if (!state.scanHistoryId) state.scanHistoryId = historyID((await request(`${GMAIL}/profile`, accessToken)).historyId)
        const query = new URLSearchParams({ maxResults: "100", labelIds: "INBOX", q: `after:${Math.max(0, Math.floor(state.boundary / 1000) - 1)}` })
        if (state.nextPageToken) query.set("pageToken", state.nextPageToken)
        url = `${GMAIL}/messages?${query}`
      } else {
        const query = new URLSearchParams({ startHistoryId: historyID(state.historyId), historyTypes: "messageAdded", maxResults: "100", labelId: "INBOX" })
        if (state.nextPageToken) query.set("pageToken", state.nextPageToken)
        url = `${GMAIL}/history?${query}`
      }
    } else {
      const initial = `${GRAPH}/mailFolders/inbox/messages/delta?${new URLSearchParams({ "$select": "id", "$top": "100" })}`
      url = graphLink(state.nextPageToken || state.deltaLink || initial)
    }
    let page
    try { page = await request(url, accessToken) } catch (error) {
      if (!expired(error, state)) throw error
      // Failed request already spent this call's page allowance. Re-scan NEXT call.
      // An unfinished initial scan may restart from its saved enable/anchor boundary.
      const initialScan = state.mode === "gmail-scan" || (state.mode === "ms-delta" && !state.deltaLink)
      if (account.lastSuccessfulSyncAt == null && !initialScan) fail("MAILBOX_EXPIRED_CURSOR_REQUIRES_LAST_SYNC_TIME")
      const boundary = account.lastSuccessfulSyncAt == null ? state.boundary
        : Math.max(state.boundary, timestamp(account.lastSuccessfulSyncAt, "MAILBOX_INVALID_LAST_SYNC_TIME"))
      checkpoint.mailboxSync = fresh(provider, boundary, state.excludeId)
      return result(true)
    }
    if (provider === "gmail") {
      state.nextPageToken = pageToken(page.nextPageToken)
      if (state.mode === "gmail-scan") state.pendingIds = ids(page.messages ?? [])
      else {
        if (page.history != null && !Array.isArray(page.history)) fail("MAILBOX_INVALID_PAGE")
        const added = []
        for (const record of page.history ?? []) {
          if (record.messagesAdded != null && !Array.isArray(record.messagesAdded)) fail("MAILBOX_INVALID_PAGE")
          for (const item of record.messagesAdded ?? []) added.push(item.message)
        }
        state.pendingIds = ids(added)
        // A nonfinal page's historyId may be ahead of unseen pages. Do NOT commit it.
        state.finalCursor = state.nextPageToken ? null : historyID(page.historyId)
      }
    } else {
      if (!Array.isArray(page.value)) fail("MAILBOX_INVALID_PAGE")
      state.pendingIds = ids(page.value.filter(item => !item?.["@removed"]))
      const next = pageToken(page["@odata.nextLink"])
      const delta = pageToken(page["@odata.deltaLink"])
      if ((!next && !delta) || (next && delta)) fail("MICROSOFT_INVALID_DELTA_PAGE")
      state.nextPageToken = next ? graphLink(next) : null
      state.finalCursor = delta ? graphLink(delta) : null
    }
    state.pageLoaded = true
  }
  while (remaining > 0 && state.pendingIds.length) {
    const id = state.pendingIds[0]
    remaining--
    const message = await detail(provider, id, accessToken)
    // Inclusive timestamp boundary preserves other messages in the same millisecond.
    if (message && message.receivedAt >= state.boundary && id !== state.excludeId) messages.push(message)
    state.pendingIds.shift()
  }
  if (state.pendingIds.length) return result(true)
  state.pageLoaded = false
  if (state.nextPageToken) return result(true)

  // Watermark is cycle START, never wall time after draining the last page.
  // Only a fully drained cycle is successful; partial pages cannot advance it.
  checkpoint.lastSuccessfulSyncAt = new Date(Math.max(
    state.cycleStartedAt,
    account.lastSuccessfulSyncAt == null ? 0 : timestamp(account.lastSuccessfulSyncAt, "MAILBOX_INVALID_LAST_SYNC_TIME"),
  )).toISOString()
  state.cycleStartedAt = null
  if (state.mode === "gmail-scan") {
    state.historyId = state.scanHistoryId
    state.scanHistoryId = null
    state.mode = "gmail-history"
    return result(true)
  }
  if (provider === "gmail") state.historyId = historyID(state.finalCursor)
  else state.deltaLink = graphLink(state.finalCursor)
  state.finalCursor = null
  return result(false)
}
