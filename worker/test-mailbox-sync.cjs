// Runs on managed Node and ordinary Node: node test-mailbox-sync.cjs
const fs = require('fs')
const source = fs.readFileSync(__dirname + '/mailbox-sync.mjs', 'utf8').replace(/^export\s+/gm, '')
const G = 'https://gmail.googleapis.com/gmail/v1/users/me'
const M = 'https://graph.microsoft.com/v1.0/me'
const T = Date.parse('2026-09-18T00:00:00Z')
function ok(value, message = 'assertion failed') { if (!value) throw new Error(message) }
function eq(a, b) { ok(JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) + ' != ' + JSON.stringify(b)) }
function clone(a) { return JSON.parse(JSON.stringify(a)) }
async function rejects(fn, pattern) {
  try { await fn() } catch (e) { ok(pattern.test(e.message), 'unexpected: ' + e.message); return }
  throw new Error('expected rejection ' + pattern)
}
function harness(handler) {
  const calls = []
  class Clock extends Date { static now() { return T + 60000 } }
  const discover = new Function('fetch', 'URL', 'URLSearchParams', 'Date', source + '\nreturn discoverMessages')(
    async (url, options) => {
      calls.push(String(url))
      eq(options.redirect, 'manual')
      eq(options.headers.Authorization, 'Bearer TEST')
      const result = await handler(new URL(url), calls)
      ok(result !== undefined, 'unhandled request: ' + url)
      const status = result.status || 200
      return { ok: status >= 200 && status < 300, status, json: async () => result.body === undefined ? result : result.body }
    }, URL, URLSearchParams, Clock,
  )
  return { calls, async run(account, budget) {
    const before = JSON.stringify(account)
    const count = calls.length
    try { return await discover(account, 'TEST', budget) } finally {
      eq(JSON.stringify(account), before)
      const newCalls = calls.slice(count)
      ok(newCalls.filter(s => /\/messages\/[^/?]+\?/.test(s) && !s.includes('/messages/delta?')).length <= (budget === undefined ? 20 : Number.isFinite(budget) && budget >= 1 ? Math.min(Math.floor(budget), 20) : 0), 'detail cap')
      ok(newCalls.filter(s => /\/(history|messages)(\?|\/delta\?)/.test(s)).length <= 1, 'page cap')
    }
  } }
}
function gmail(id, at = T + 1) { return { id, internalDate: String(at), payload: { headers: [{ name: 'Subject', value: id }] } } }
function ms(id, at = T + 1) { return { id, receivedDateTime: new Date(at).toISOString(), subject: id } }
function apply(account, result, outbox = new Map()) {
  for (const message of result.messages) outbox.set(account.provider + ':' + account.id + ':' + message.id, message)
  Object.assign(account, clone(result.checkpoint))
  return outbox
}
const tests = []
function test(name, fn) { tests.push([name, fn]) }
for (const provider of ['gmail', 'microsoft']) {
  test(provider + ': 137 messages, inclusive enable boundary, bounded pages/details, JSON resume', async () => {
    const all = Array.from({ length: 140 }, (_, i) => 'm' + i)
    let pages = 0
    const account = { id: 'a', provider, pushEnabledAt: T }
    const outbox = new Map()
    const h = harness(url => {
      if (url.pathname.endsWith('/profile')) return { historyId: '10' }
      if (url.pathname.endsWith('/history')) { eq(url.searchParams.get('startHistoryId'), '10'); return { historyId: '11', history: [{ messagesAdded: [{ message: { id: 'm139' } }] }] } }
      if (url.pathname.endsWith('/messages') || url.pathname.endsWith('/messages/delta')) {
        pages++
        const second = url.searchParams.has('pageToken') || url.searchParams.has('page')
        const part = second ? all.slice(100) : all.slice(0, 100)
        if (provider === 'gmail') return { messages: part.map(id => ({ id })), ...(second ? {} : { nextPageToken: 'p2' }) }
        return { value: part.map(id => ({ id })), [second ? '@odata.deltaLink' : '@odata.nextLink']: M + '/mailFolders/inbox/messages/delta?' + (second ? 'delta=done' : 'page=2') }
      }
      const id = decodeURIComponent(url.pathname.split('/').pop())
      const at = Number(id.slice(1)) < 3 ? T - 1 : T
      return provider === 'gmail' ? gmail(id, at) : ms(id, at)
    })
    let done = false
    for (let i = 0; i < 20; i++) {
      const result = await h.run(account, 999)
      if (i === 0) {
        eq(result.checkpoint.mailboxSync.pendingIds.length, 80)
        ok(result.checkpoint.mailboxSync.nextPageToken)
        ok(!result.checkpoint.lastSuccessfulSyncAt)
      }
      apply(account, result, outbox)
      if (!result.more) { done = true; break }
    }
    ok(done)
    eq(pages, 2)
    eq(outbox.size, 137)
    ok(account.lastSuccessfulSyncAt)
    if (provider === 'gmail') eq(account.mailboxSync.historyId, '11')
    else ok(account.mailboxSync.deltaLink.endsWith('delta=done'))
  })
  test(provider + ': legacy anchor time (not list position), same-time peers retained', async () => {
    const account = { provider, newestId: 'anchor' }
    const h = harness(url => {
      if (url.pathname.endsWith('/profile')) return { historyId: '5' }
      if (url.pathname.endsWith('/messages')) return { messages: ['old', 'anchor', 'peer', 'new'].map(id => ({ id })) }
      if (url.pathname.endsWith('/messages/delta')) return { value: ['old', 'anchor', 'peer', 'new'].map(id => ({ id })), '@odata.deltaLink': M + '/mailFolders/inbox/messages/delta?delta=x' }
      const id = url.pathname.split('/').pop()
      const at = id === 'old' ? T - 1 : id === 'new' ? T + 1 : T
      return provider === 'gmail' ? gmail(id, at) : ms(id, at)
    })
    const first = await h.run(account, 1)
    eq(first.messages, [])
    eq(first.checkpoint.mailboxSync.boundary, T)
    apply(account, first)
    const next = await h.run(account)
    eq(next.messages.map(m => m.id), ['peer', 'new'])
    eq(account.newestId, '')
  })
  test(provider + ': deleted legacy anchor fails without last sync even with pushEnabledAt', async () => {
    const h = harness(() => ({ status: 404 }))
    await rejects(() => h.run({ provider, newestId: 'gone', pushEnabledAt: T }), /LEGACY_ANCHOR_DELETED_REQUIRES_BOUNDARY/)
    eq(h.calls.length, 1)
  })
  test(provider + ': deleted legacy anchor recovers from last successful sync', async () => {
    const h = harness(url => {
      if (url.pathname.endsWith('/gone')) return { status: 404 }
      if (url.pathname.endsWith('/profile')) return { historyId: '1' }
      if (provider === 'gmail') return { messages: [] }
      return { value: [], '@odata.deltaLink': M + '/mailFolders/inbox/messages/delta?delta=x' }
    })
    const r = await h.run({ provider, newestId: 'gone', lastSuccessfulSyncAt: T })
    eq(r.checkpoint.mailboxSync.boundary, T)
  })
  test(provider + ': detail 404 skipped, 503 aborts without mutating nested checkpoint', async () => {
    let failDetail = false
    const h = harness(url => {
      if (url.pathname.endsWith('/profile')) return { historyId: '1' }
      if (url.pathname.endsWith('/messages')) return { messages: ['a', 'gone', 'b'].map(id => ({ id })) }
      if (url.pathname.endsWith('/messages/delta')) return { value: ['a', 'gone', 'b'].map(id => ({ id })), '@odata.deltaLink': M + '/mailFolders/inbox/messages/delta?delta=x' }
      const id = url.pathname.split('/').pop()
      if (id === 'gone') return { status: 404 }
      if (failDetail) return { status: 503 }
      return provider === 'gmail' ? gmail(id) : ms(id)
    })
    const account = { provider, pushEnabledAt: T }
    apply(account, await h.run(account, 1))
    failDetail = true
    await rejects(() => h.run(account), /HTTP_503/)
    failDetail = false
    const r = await h.run(account)
    eq(r.messages.map(m => m.id), ['b'])
  })
  test(provider + ': missing fresh-account boundary fails closed', async () => {
    const h = harness(() => { throw new Error('must not fetch') })
    await rejects(() => h.run({ provider }), /PUSH_ENABLED_AT_REQUIRED/)
  })
}
function state(provider, extra = {}) {
  return { version: 1, provider, mode: provider === 'gmail' ? 'gmail-history' : 'ms-delta', boundary: T, excludeId: '', pendingIds: [], nextPageToken: null, pageLoaded: false, cycleStartedAt: null, historyId: '10', scanHistoryId: null, deltaLink: provider === 'microsoft' ? M + '/mailFolders/inbox/messages/delta?delta=old' : null, finalCursor: null, ...extra }
}
test('Gmail: messagesAdded only, per-page dedup, cursor held until final details', async () => {
  let pages = 0
  const h = harness(url => {
    if (url.pathname.endsWith('/history')) {
      pages++
      eq(url.searchParams.get('startHistoryId'), '10')
      return pages === 1 ? { historyId: '999', nextPageToken: 'p2', history: [{ messages: [{ id: 'ignore' }], labelsAdded: [{ message: { id: 'ignore' } }], messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'a' } }, { message: { id: 'b' } }] }] }
        : { historyId: '1000', history: [{ messagesAdded: [{ message: { id: 'c' } }, { message: { id: 'd' } }] }] }
    }
    return gmail(url.pathname.split('/').pop())
  })
  const account = { provider: 'gmail', mailboxSync: state('gmail'), lastSuccessfulSyncAt: T }
  let r = await h.run(account, 1)
  eq(r.messages.map(m => m.id), ['a']); eq(r.checkpoint.mailboxSync.historyId, '10'); apply(account, r)
  r = await h.run(account, 1)
  eq(pages, 1); eq(r.messages.map(m => m.id), ['b']); apply(account, r)
  r = await h.run(account, 1)
  eq(r.checkpoint.mailboxSync.historyId, '10'); ok(!r.checkpoint.lastSuccessfulSyncAt); apply(account, r)
  r = await h.run(account, 1)
  eq(r.checkpoint.mailboxSync.historyId, '1000'); eq(r.more, false)
})
for (const provider of ['gmail', 'microsoft']) {
  test(provider + ': expired cursor consumes page allowance; recovery uses last sync', async () => {
    const h = harness(() => ({ status: provider === 'gmail' ? 404 : 410 }))
    const account = { provider, mailboxSync: state(provider), lastSuccessfulSyncAt: T + 1000 }
    const r = await h.run(account)
    eq(h.calls.length, 1); eq(r.more, true); eq(r.messages, [])
    eq(r.checkpoint.mailboxSync.boundary, T + 1000)
    ok(!r.checkpoint.lastSuccessfulSyncAt)
    delete account.lastSuccessfulSyncAt
    await rejects(() => h.run(account), /EXPIRED_CURSOR_REQUIRES_LAST_SYNC_TIME/)
  })
  test(provider + ': page 401/403/429/500 do not commit', async () => {
    for (const status of [401, 403, 429, 500]) {
      const h = harness(() => ({ status }))
      await rejects(() => h.run({ provider, mailboxSync: state(provider), lastSuccessfulSyncAt: T }), new RegExp('HTTP_' + status))
    }
  })
}
test('Microsoft: validates stored and returned next/delta origins before fetching details', async () => {
  for (const link of ['https://evil.example/steal', 'http://graph.microsoft.com/x', 'https://graph.microsoft.com.evil/x', 'https://user:pass@graph.microsoft.com/x', '/relative']) {
    const h = harness(() => { throw new Error('must not fetch') })
    await rejects(() => h.run({ provider: 'microsoft', mailboxSync: state('microsoft', { nextPageToken: link }) }), /INVALID_NEXT_LINK/)
    eq(h.calls.length, 0)
    for (const key of ['@odata.nextLink', '@odata.deltaLink']) {
      const h2 = harness(() => ({ value: [{ id: 'a' }], [key]: link }))
      await rejects(() => h2.run({ provider: 'microsoft', pushEnabledAt: T }), /INVALID_NEXT_LINK/)
      eq(h2.calls.length, 1)
    }
  }
})
test('Microsoft: removals skipped, empty intermediate page resumes, final delta reused', async () => {
  let n = 0
  const h = harness(url => {
    n++
    if (n === 1) return { value: [{ id: 'gone', '@removed': { reason: 'deleted' } }], '@odata.nextLink': M + '/mailFolders/inbox/messages/delta?page=2' }
    if (n === 2) eq(url.searchParams.get('page'), '2')
    if (n === 3) eq(url.searchParams.get('delta'), 'done')
    return { value: [], '@odata.deltaLink': M + '/mailFolders/inbox/messages/delta?delta=done' }
  })
  const a = { provider: 'microsoft', pushEnabledAt: T }
  let r = await h.run(a); eq(r.more, true); apply(a, r)
  r = await h.run(a); eq(r.more, false); apply(a, r)
  await h.run(a); eq(n, 3)
})
test('Gmail: invalid page token defers rescan, generic 400 does not reset', async () => {
  const a = { provider: 'gmail', mailboxSync: state('gmail', { nextPageToken: 'bad' }), lastSuccessfulSyncAt: T }
  const h = harness(() => ({ status: 400, body: { error: { message: 'Invalid page token' } } }))
  eq((await h.run(a)).checkpoint.mailboxSync.mode, 'gmail-scan')
  eq(h.calls.length, 1)
  const bad = harness(() => ({ status: 400, body: { error: { message: 'Invalid argument' } } }))
  await rejects(() => bad.run(a), /HTTP_400/)
})
test('Outbox failure: no checkpoint applied, retry rediscovers; stable-ID dedup', async () => {
  const h = harness(url => url.pathname.endsWith('/history')
    ? { historyId: '11', history: [{ messagesAdded: [{ message: { id: 'a' } }] }] }
    : gmail('a'))
  const a = { id: 'account', provider: 'gmail', mailboxSync: state('gmail') }
  const first = await h.run(a)
  const retry = await h.run(a)
  eq(first, retry)
  const outbox = apply(a, retry)
  apply(a, first, outbox)
  eq(outbox.size, 1)
})
test('Gmail: scan captures history before listing; concurrent addition recovered', async () => {
  const h = harness(url => {
    if (url.pathname.endsWith('/profile')) return { historyId: '41' }
    if (url.pathname.endsWith('/messages')) return { messages: [] }
    if (url.pathname.endsWith('/history')) { eq(url.searchParams.get('startHistoryId'), '41'); return { historyId: '42', history: [{ messagesAdded: [{ message: { id: 'concurrent' } }] }] } }
    return gmail('concurrent', T + 65000)
  })
  const a = { provider: 'gmail', pushEnabledAt: T }
  const r = await h.run(a); eq(r.more, true); apply(a, r)
  eq((await h.run(a)).messages.map(m => m.id), ['concurrent'])
  ok(h.calls[0].endsWith('/profile'))
})
for (const provider of ['gmail', 'microsoft']) {
  test(provider + ': expired cursor rescan preserves messages since last sync, not only newest', async () => {
    let expired = false
    const h = harness(url => {
      if (!expired) { expired = true; return { status: provider === 'gmail' ? 404 : 410 } }
      if (url.pathname.endsWith('/profile')) return { historyId: '20' }
      if (url.pathname.endsWith('/messages')) return { messages: ['before', 'equal', 'after'].map(id => ({ id })) }
      if (url.pathname.endsWith('/messages/delta')) return { value: ['before', 'equal', 'after'].map(id => ({ id })), '@odata.deltaLink': M + '/mailFolders/inbox/messages/delta?delta=new' }
      const id = url.pathname.split('/').pop()
      const at = id === 'before' ? T + 999 : id === 'equal' ? T + 1000 : T + 1001
      return provider === 'gmail' ? gmail(id, at) : ms(id, at)
    })
    const a = { provider, mailboxSync: state(provider), lastSuccessfulSyncAt: T + 1000 }
    apply(a, await h.run(a))
    const r = await h.run(a)
    eq(r.messages.map(m => m.id), ['equal', 'after'])
  })
  test(provider + ': mid-batch failure rolls back earlier successful detail and cursor', async () => {
    const h = harness(url => {
      const id = url.pathname.split('/').pop()
      if (id === 'b') return { status: 429 }
      return provider === 'gmail' ? gmail(id) : ms(id)
    })
    const a = { provider, mailboxSync: state(provider, { pendingIds: ['a', 'b'], pageLoaded: true, finalCursor: provider === 'gmail' ? '20' : M + '/mailFolders/inbox/messages/delta?delta=new' }) }
    await rejects(() => h.run(a), /HTTP_429/)
    eq(a.mailboxSync.pendingIds, ['a', 'b'])
  })
}
test('Budget validation and malformed final page fail closed', async () => {
  const h = harness(() => ({ value: [] }))
  for (const budget of [0, -1, NaN, Infinity]) await rejects(() => h.run({ provider: 'microsoft', pushEnabledAt: T }, budget), /INVALID_BUDGET/)
  eq(h.calls.length, 0)
  await rejects(() => h.run({ provider: 'microsoft', pushEnabledAt: T }), /INVALID_DELTA_PAGE/)
})
;(async () => {
  let passed = 0
  for (const [name, fn] of tests) { await fn(); console.log('PASS ' + name); passed++ }
  console.log('\n' + passed + '/' + tests.length + ' passed; no network, no npm dependencies')
})().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
