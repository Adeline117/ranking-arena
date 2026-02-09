/**
 * Clean up fake/test trader records:
 * - "中台未注册" (MEXC test accounts)
 * - Inactive traders with placeholder handles and no snapshots
 */
import pg from 'pg'
const { Client } = pg

const DB = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'

async function main() {
  const client = new Client({ connectionString: DB })
  await client.connect()

  // 1. Delete MEXC test accounts (中台未注册)
  const { rowCount: zhongtai } = await client.query(
    `DELETE FROM trader_sources WHERE source = 'mexc' AND handle LIKE '中台未注册%'`
  )
  console.log(`Deleted ${zhongtai} MEXC test accounts (中台未注册)`)

  // 2. Count remaining bad handles by source
  const { rows } = await client.query(`
    SELECT source, COUNT(*) as cnt FROM trader_sources 
    WHERE handle = source_trader_id 
       OR handle LIKE 'XT Trader %'
       OR handle LIKE 'Mexctrader-%'
       OR handle LIKE '@BGUSER-%'
    GROUP BY source ORDER BY cnt DESC
  `)
  console.log('\nRemaining bad handles:')
  for (const r of rows) {
    console.log(`  ${r.source}: ${r.cnt}`)
  }

  // 3. Stats
  const { rows: total } = await client.query('SELECT COUNT(*) as cnt FROM trader_sources')
  console.log(`\nTotal traders: ${total[0].cnt}`)

  await client.end()
}

main().catch(console.error)
