import assert from 'node:assert/strict'
import test from 'node:test'
import { TEST_USER, buildFixtures, queryRelation, startFakeSupabase } from './fake-supabase.mjs'

const rows = buildFixtures(new Date('2026-10-30T00:00:00.000Z')).public_ranked_leaderboard

function query(text) {
  return queryRelation(rows, new URLSearchParams(text))
}

test('filters by period, so each period has its own traders', () => {
  const week = query('season_id=eq.7D')
  assert.ok(week.length > 0)
  assert.ok(week.every((row) => row.season_id === '7D'))
  const own = week.filter((row) => row.source_trader_id !== 'e2e-shared')
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
  assert.ok(excluded.every((row) => row.source === 'binance_futures'))
  const allowed = query('season_id=eq.90D&source=in.(hyperliquid)')
  assert.ok(allowed.length > 0)
  assert.ok(allowed.every((row) => row.source === 'hyperliquid'))
})

test('orders and pages like PostgREST range requests', () => {
  const page = query('season_id=eq.90D&order=rank.desc&offset=1&limit=2')
  assert.deepEqual(
    page.map((row) => row.rank),
    [30, 29]
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
