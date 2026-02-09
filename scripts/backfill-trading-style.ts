/**
 * Backfill trading_style for all trader_snapshots.
 * Uses the same logic as lib/utils/trading-style.ts classifyStyle().
 *
 * Run: npx tsx scripts/backfill-trading-style.ts
 */

import pg from 'pg'

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'

// DB CHECK constraint allows: hft, day_trader, swing, trend, scalping, scalper, position, unknown
function classifyStyle(row: {
  avg_holding_hours: number | null
  trades_count: number | null
  win_rate: number | null
  profit_factor: number | null
}): string {
  const { avg_holding_hours, trades_count, win_rate, profit_factor } = row

  if (avg_holding_hours != null && avg_holding_hours > 0) {
    if (avg_holding_hours < 4 && (trades_count ?? 0) > 50) return 'scalper'
    if (avg_holding_hours < 48) return 'swing'
    if (avg_holding_hours < 336) return 'trend'
    return 'position'
  }

  // Fallback without holding hours
  if ((win_rate ?? 0) > 60 && (profit_factor ?? 2) < 1.5) return 'scalper'

  return 'unknown'
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()

  console.log('Fetching trader_snapshots with null trading_style...')
  const { rows } = await client.query(`
    SELECT id, avg_holding_hours, trades_count, win_rate, profit_factor
    FROM trader_snapshots
    WHERE trading_style IS NULL
  `)
  console.log(`Found ${rows.length} rows to update.`)

  // Group by style for batch updates
  const groups: Record<string, number[]> = {}
  for (const row of rows) {
    const style = classifyStyle(row)
    ;(groups[style] ??= []).push(row.id)
  }

  for (const [style, ids] of Object.entries(groups)) {
    console.log(`Setting ${ids.length} rows to '${style}'...`)
    // Batch in chunks of 5000
    for (let i = 0; i < ids.length; i += 5000) {
      const chunk = ids.slice(i, i + 5000)
      await client.query(
        `UPDATE trader_snapshots SET trading_style = $1 WHERE id = ANY($2)`,
        [style, chunk]
      )
    }
  }
  console.log(`Update complete.`)

  console.log('Done!')
  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
