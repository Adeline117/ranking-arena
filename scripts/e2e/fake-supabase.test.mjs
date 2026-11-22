import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALIAS_TRADER,
  STALE_AGE_MS,
  TEST_USER,
  buildFixtures,
  callRpc,
  queryRelation,
  startFakeSupabase,
} from './fake-supabase.mjs'

const rows = buildFixtures(new Date('2026-10-30T00:00:00.000Z')).public_ranked_leaderboard

function query(text) {
  return queryRelation(rows, new URLSearchParams(text))
}

test('filters by period, so each period has its own traders', () => {
  const week = query('season_id=eq.7D')
  assert.ok(week.length > 0)
  assert.ok(week.every((row) => row.season_id === '7D'))
  // Shared and null-metrics traders are ranked in every period on purpose.
  const own = week.filter((row) => row.source_trader_id.startsWith('e2e-7d-'))
  assert.ok(own.length > 0)
  assert.ok(own.every((row) => row.handle.startsWith('E2E 7D ')))
  assert.deepEqual(
    week.filter((row) => row.source_trader_id === 'e2e-shared').map((row) => row.roi),
    [111]
  )
})

test('honours the source exclusion and allowlist the leaderboard reader sends', () => {
  const excluded = query('season_id=eq.90D&source=not.in.(hyperliquid)')
  assert.ok(excluded.length > 0)
  assert.ok(excluded.every((row) => row.source !== 'hyperliquid'))
  assert.ok(excluded.some((row) => row.source === 'binance_futures'))
  const allowed = query('season_id=eq.90D&source=in.(hyperliquid)')
  assert.ok(allowed.length > 0)
  assert.ok(allowed.every((row) => row.source === 'hyperliquid'))
})

test('orders and pages like PostgREST range requests', () => {
  const page = query('season_id=eq.90D&order=rank.desc&offset=2&limit=2')
  assert.deepEqual(
    page.map((row) => row.rank),
    [31, 30]
  )
})

test('applies or-filters, as trader search does', () => {
  const found = query('or=(handle.ilike.%25E2E 90D Trader 1%25,source_trader_id.ilike.%25none%25)')
  assert.ok(found.length > 0)
  assert.ok(found.every((row) => row.handle.startsWith('E2E 90D Trader 1')))
})

test('an unknown operator matches nothing rather than everything', () => {
  assert.deepEqual(query('season_id=bogus.90D'), [])
})

test('serves rest requests, single-row errors and empty relations over HTTP', async (t) => {
  const server = await startFakeSupabase({ port: 0 })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/rest/v1`

  const list = await fetch(`${base}/public_ranked_leaderboard?season_id=eq.30D&limit=1`)
  assert.equal(list.status, 200)
  assert.equal((await list.json())[0].season_id, '30D')

  const none = await fetch(`${base}/public_ranked_leaderboard?season_id=eq.1D`, {
    headers: { accept: 'application/vnd.pgrst.object+json' },
  })
  assert.equal(none.status, 406)

  const empty = await fetch(`${base}/no_fixture_relation`)
  assert.deepEqual(await empty.json(), [])
})

test('answers Upstash commands and pipelines as an empty Redis', async (t) => {
  const server = await startFakeSupabase({ port: 0 })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/upstash`

  const single = await fetch(base, { method: 'POST', body: '["GET","k"]' })
  assert.deepEqual(await single.json(), { result: null })

  const pipeline = await fetch(`${base}/pipeline`, {
    method: 'POST',
    body: '[["GET","a"],["GET","b"]]',
  })
  assert.deepEqual(await pipeline.json(), [{ result: null }, { result: null }])

  // A lock SET NX on an absent key succeeds, as in a real Redis.
  const lock = await fetch(base, { method: 'POST', body: '["SET","lock:k","t","EX","10","NX"]' })
  assert.deepEqual(await lock.json(), { result: 'OK' })
})

test('signs in only with the test credentials, and the token identifies the user', async (t) => {
  const server = await startFakeSupabase({ port: 0 })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/auth/v1`
  const signIn = (password) =>
    fetch(`${base}/token?grant_type=password`, {
      method: 'POST',
      body: JSON.stringify({ email: TEST_USER.email, password }),
    })

  assert.equal((await signIn('wrong')).status, 400)
  const { access_token: token } = await (await signIn(TEST_USER.password)).json()

  const user = await fetch(`${base}/user`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await user.json()).id, TEST_USER.id)
  assert.equal((await fetch(`${base}/user`)).status, 401)
})

test('keeps watchlist writes until they are deleted', async (t) => {
  const server = await startFakeSupabase({ port: 0 })
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/rest/v1/trader_watchlist`
  const row = { user_id: 'u', source: 's', source_trader_id: 't' }

  await fetch(url, { method: 'POST', body: JSON.stringify(row) })
  await fetch(url, { method: 'POST', body: JSON.stringify(row) })
  assert.equal((await (await fetch(`${url}?user_id=eq.u`)).json()).length, 1)

  await fetch(`${url}?source_trader_id=eq.t`, { method: 'DELETE' })
  assert.deepEqual(await (await fetch(url)).json(), [])
})

test('switches into a degraded leaderboard scenario and back', async (t) => {
  const server = await startFakeSupabase({ port: 0 })
  t.after(() => server.close())
  const root = `http://127.0.0.1:${server.address().port}`
  const board = `${root}/rest/v1/public_ranked_leaderboard?season_id=eq.90D`
  const freshness = `${root}/rest/v1/leaderboard_source_freshness?season_id=eq.90D`
  const use = (name) =>
    fetch(`${root}/__e2e/scenario`, { method: 'POST', body: JSON.stringify({ name }) })

  assert.equal((await use('no-such-scenario')).status, 400)

  await use('leaderboard-empty')
  assert.deepEqual(await (await fetch(board)).json(), [])

  await use('leaderboard-error')
  assert.equal((await fetch(board)).status, 500)
  assert.equal((await fetch(freshness)).status, 500)
  // Only the ranking relations fail; the rest of the app still answers.
  assert.equal((await fetch(`${root}/rest/v1/user_profiles`)).status, 200)

  const ageOf = async (url, column) =>
    Date.now() - Date.parse((await (await fetch(url)).json())[0][column])
  const old = (age) => age >= STALE_AGE_MS - 60_000
  await use('leaderboard-stale-source')
  assert.ok(old(await ageOf(freshness, 'source_as_of')))
  assert.ok(!old(await ageOf(board, 'computed_at')))
  await use('leaderboard-stale-computed')
  assert.ok(!old(await ageOf(freshness, 'source_as_of')))
  assert.ok(old(await ageOf(board, 'computed_at')))

  await use('normal')
  assert.equal((await (await fetch(`${root}/__e2e/scenario`)).json()).name, 'normal')
  assert.ok((await (await fetch(board)).json()).length > 0)
})

test('has a ranked trader whose source published no optional metrics', () => {
  const nulls = query('source_trader_id=eq.e2e-null-metrics&season_id=eq.90D')
  assert.equal(nulls.length, 1)
  for (const column of ['trades_count', 'followers', 'copiers', 'sharpe_ratio']) {
    assert.equal(nulls[0][column], null, column)
  }
})

test('an alias-source trader: ranked under the alias, resolved to the slug by either name', () => {
  const ranked = query('season_id=eq.90D&source_trader_id=eq.e2e-alias')
  assert.deepEqual(
    ranked.map((row) => row.source),
    [ALIAS_TRADER.publicSource]
  )
  for (const p_source of [ALIAS_TRADER.publicSource, ALIAS_TRADER.servingSource, null]) {
    const resolved = callRpc('arena_resolve_trader', { p_handle: 'e2e-alias', p_source })
    assert.equal(resolved.source, ALIAS_TRADER.servingSource)
    // Like the deployed resolver today: no public name in the answer.
    assert.equal(resolved.publicSource, undefined)
  }
  assert.equal(callRpc('arena_resolve_trader', { p_handle: 'e2e-alias', p_source: 'okx' }), null)
  assert.equal(callRpc('arena_resolve_trader', { p_handle: 'e2e-shared', p_source: null }), null)
  assert.equal(
    callRpc('arena_first_screen', { p_source: ALIAS_TRADER.publicSource, p_trader: 'e2e-alias' }),
    null
  )
  assert.deepEqual(callRpc('some_other_rpc', {}), [])
})
