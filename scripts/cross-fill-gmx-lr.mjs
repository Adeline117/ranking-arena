#!/usr/bin/env node
/**
 * cross-fill-gmx-lr.mjs
 * Cross-fills GMX leaderboard_ranks max_drawdown from trader_snapshots.
 * Uses case-insensitive address matching.
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import pg from 'pg'
const { Client } = pg

const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_URL

async function main() {
  console.log('=== GMX LR Cross-fill from trader_snapshots ===')

  const client = new Client(DB_URL)
  await client.connect()

  // Use SQL JOIN with case-insensitive matching
  const { rows: [before] } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE max_drawdown IS NULL) as null_count, COUNT(*) as total FROM leaderboard_ranks WHERE source='gmx'`
  )
  console.log(`Before: ${before.null_count}/${before.total} null MDD`)

  const { rowCount } = await client.query(`
    UPDATE leaderboard_ranks lr
    SET max_drawdown = ts.max_drawdown
    FROM (
      SELECT DISTINCT ON (lower(source_trader_id), season_id) 
        lower(source_trader_id) as addr, season_id, max_drawdown
      FROM trader_snapshots 
      WHERE source = 'gmx' AND max_drawdown IS NOT NULL
      ORDER BY lower(source_trader_id), season_id, max_drawdown
    ) ts
    WHERE lr.source = 'gmx'
      AND lr.max_drawdown IS NULL
      AND ts.max_drawdown IS NOT NULL
      AND lower(lr.source_trader_id) = ts.addr
      AND lr.season_id = ts.season_id
  `)
  console.log(`Updated: ${rowCount} rows`)

  const { rows: [after] } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE max_drawdown IS NULL) as null_count, COUNT(*) as total FROM leaderboard_ranks WHERE source='gmx'`
  )
  console.log(`After: ${after.null_count}/${after.total} null MDD`)
  console.log(`Filled: ${before.null_count - after.null_count}`)

  await client.end()
}

main().catch(e => { console.error(e); process.exit(1) })
