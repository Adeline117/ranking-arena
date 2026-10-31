import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFixtures, queryRelation, startFakeSupabase } from './fake-supabase.mjs'

const rows = buildFixtures(new Date('2026-10-30T00:00:00.000Z')).public_ranked_leaderboard

function query(text) {
  return queryRelation(rows, new URLSearchParams(text))
}

test('filters by period, so each period has its own traders', () => {
  const week = query('season_id=eq.7D')
  assert.ok(week.length > 0)
  assert.ok(week.every((row) => row.season_id === '7D'))
  assert.ok(week.every((row) => row.handle.startsWith('E2E 7D ')))
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
    [29, 28]
  )
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
