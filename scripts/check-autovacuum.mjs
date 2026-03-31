#!/usr/bin/env node
/**
 * Check autovacuum stats for high-write tables.
 *
 * Usage:
 *   node scripts/check-autovacuum.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env.local
function loadEnv() {
  try {
    const content = readFileSync(join(__dirname, '..', '.env.local'), 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2]
      }
    }
  } catch (_) {}
}

loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const TABLES = [
  'leaderboard_ranks',
  'trader_snapshots_v2',
  'trader_daily_snapshots',
]

async function main() {
  console.log('=== Autovacuum Stats ===\n')

  const { data, error } = await supabase.rpc('exec_sql', {
    sql: `
      SELECT relname, n_live_tup, n_dead_tup,
        CASE WHEN n_live_tup > 0 THEN round(n_dead_tup::numeric / n_live_tup * 100, 1) ELSE 0 END as dead_pct,
        last_vacuum, last_autovacuum
      FROM pg_stat_user_tables
      WHERE relname IN ('leaderboard_ranks', 'trader_snapshots_v2', 'trader_daily_snapshots')
      ORDER BY n_dead_tup DESC;
    `,
  })

  if (error) {
    // Fallback: query each table individually via Supabase REST
    console.log('exec_sql RPC not available, using direct table queries...\n')
    for (const table of TABLES) {
      const { count, error: countErr } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
      if (countErr) {
        console.log(`  ${table}: ERROR — ${countErr.message}`)
      } else {
        console.log(`  ${table}: ~${count?.toLocaleString()} rows`)
      }
    }
    console.log(
      '\nNote: For full autovacuum stats, create an exec_sql RPC or run the query directly in Supabase SQL editor:\n'
    )
    console.log(`  SELECT relname, n_live_tup, n_dead_tup,
    CASE WHEN n_live_tup > 0 THEN round(n_dead_tup::numeric / n_live_tup * 100, 1) ELSE 0 END as dead_pct,
    last_vacuum, last_autovacuum
  FROM pg_stat_user_tables
  WHERE relname IN ('leaderboard_ranks', 'trader_snapshots_v2', 'trader_daily_snapshots')
  ORDER BY n_dead_tup DESC;`)
    return
  }

  if (!data || data.length === 0) {
    console.log('No data returned.')
    return
  }

  // Format output
  const header = `${'Table'.padEnd(30)} ${'Live'.padStart(12)} ${'Dead'.padStart(12)} ${'Dead%'.padStart(8)} ${'Last Vacuum'.padEnd(22)} Last Autovacuum`
  console.log(header)
  console.log('-'.repeat(header.length))

  for (const row of data) {
    const liveTup = Number(row.n_live_tup || 0).toLocaleString()
    const deadTup = Number(row.n_dead_tup || 0).toLocaleString()
    const deadPct = `${row.dead_pct || 0}%`
    const lastVac = row.last_vacuum ? new Date(row.last_vacuum).toISOString().slice(0, 19) : 'never'
    const lastAutoVac = row.last_autovacuum ? new Date(row.last_autovacuum).toISOString().slice(0, 19) : 'never'

    console.log(
      `${String(row.relname).padEnd(30)} ${liveTup.padStart(12)} ${deadTup.padStart(12)} ${deadPct.padStart(8)} ${lastVac.padEnd(22)} ${lastAutoVac}`
    )

    // Warn if dead tuple ratio is high
    if (Number(row.dead_pct) > 20) {
      console.log(`  ⚠️  High dead tuple ratio! Consider running: VACUUM ANALYZE ${row.relname};`)
    }
  }
}

main().catch(console.error)
