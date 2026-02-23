/**
 * Backfill 24H window snapshots from 7D baseline and fill latest 7 days.
 *
 * Why this exists:
 * - Some source/season pipelines only maintain 7D/30D/90D rows.
 * - Freshness and SLA checks need a dedicated 24H window row per trader.
 *
 * Usage:
 *   npx tsx scripts/backfill-window-24h.ts
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

type SnapshotRow = {
  source: string
  source_trader_id: string
  season_id: string
  captured_at: string
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  followers: number | null
  arena_score: number | null
  arena_score_v3: number | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  profit_factor: number | null
  calmar_ratio: number | null
}

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

const PAGE_SIZE = 1000
const DAYS_TO_BACKFILL = 7

function buildBackfillRows(rows: SnapshotRow[]) {
  const now = Date.now()
  const output: Record<string, unknown>[] = []

  for (const row of rows) {
    for (let dayOffset = 0; dayOffset < DAYS_TO_BACKFILL; dayOffset++) {
      const capturedAt = new Date(now - dayOffset * 24 * 60 * 60 * 1000).toISOString()
      output.push({
        source: row.source,
        source_trader_id: row.source_trader_id,
        season_id: '24H',
        captured_at: capturedAt,
        roi: row.roi,
        pnl: row.pnl,
        win_rate: row.win_rate,
        max_drawdown: row.max_drawdown,
        trades_count: row.trades_count,
        followers: row.followers,
        arena_score: row.arena_score,
        arena_score_v3: row.arena_score_v3,
        sharpe_ratio: row.sharpe_ratio,
        sortino_ratio: row.sortino_ratio,
        profit_factor: row.profit_factor,
        calmar_ratio: row.calmar_ratio,
      })
    }
  }

  return output
}

async function main() {
  console.log('=== Backfill 24H Window (last 7 days) ===')

  let page = 0
  let totalFetched = 0
  let totalUpserted = 0

  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, season_id, captured_at, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, arena_score_v3, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio')
      .eq('season_id', '7D')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

    if (error) {
      throw new Error(`Fetch failed at page ${page}: ${error.message}`)
    }

    if (!data || data.length === 0) break

    totalFetched += data.length
    const backfillRows = buildBackfillRows(data as SnapshotRow[])

    for (let i = 0; i < backfillRows.length; i += 500) {
      const chunk = backfillRows.slice(i, i + 500)
      const { error: upsertError } = await supabase
        .from('trader_snapshots')
        .upsert(chunk, { onConflict: 'source,source_trader_id,season_id,captured_at' })

      if (upsertError) {
        throw new Error(`Upsert failed at page ${page}, chunk ${i}: ${upsertError.message}`)
      }

      totalUpserted += chunk.length
    }

    if (data.length < PAGE_SIZE) break
    page += 1
  }

  console.log(`Fetched 7D traders: ${totalFetched}`)
  console.log(`Upserted 24H rows: ${totalUpserted}`)
  console.log('Done.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
