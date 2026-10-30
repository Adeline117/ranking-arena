import assert from 'node:assert/strict'
import test from 'node:test'

const { runEnrichmentInventory } = await import('../check_enrichment.mjs')
const { runSeasonInventory, summarizeRankingRows } = await import('../check_seasons.mjs')

function response(data = [], error = null) {
  return { data, error }
}

function fakeSupabase(responses) {
  return {
    from(table) {
      const query = {
        select() {
          return query
        },
        not() {
          return query
        },
        limit() {
          return Promise.resolve(responses[table] || response())
        },
      }
      return query
    },
  }
}

test('enrichment inventory fails closed on a current-relation query error', async () => {
  const supabase = fakeSupabase({
    trader_stats_detail: response([{ source: 'alpha', period: '90D' }]),
    trader_equity_curve: response([], { message: 'schema drift' }),
  })

  await assert.rejects(
    runEnrichmentInventory(supabase),
    /trader_equity_curve query failed: schema drift/
  )
})

test('season inventory fails closed when current ranked rows cannot be read', async () => {
  const supabase = fakeSupabase({
    leaderboard_ranks: response([], { message: 'permission denied' }),
  })

  await assert.rejects(
    runSeasonInventory(supabase),
    /leaderboard_ranks query failed: permission denied/
  )
})

test('season inventory groups only current ranked rows by source and season', () => {
  assert.deepEqual(
    summarizeRankingRows([
      { source: 'beta', season_id: '90D', computed_at: '2026-08-16T01:00:00.000Z' },
      { source: 'alpha', season_id: '7D', computed_at: '2026-08-16T02:00:00.000Z' },
      { source: 'beta', season_id: '90D', computed_at: '2026-08-16T03:00:00.000Z' },
    ]),
    [
      {
        source: 'alpha',
        season: '7D',
        count: 1,
        latestComputedAt: '2026-08-16T02:00:00.000Z',
      },
      {
        source: 'beta',
        season: '90D',
        count: 2,
        latestComputedAt: '2026-08-16T03:00:00.000Z',
      },
    ]
  )
})
