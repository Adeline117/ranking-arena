/**
 * Check available tables and data
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '../.env.local')

// Load env
try {
  for (const l of readFileSync(envPath, 'utf8').split('\n')) {
    const m = l.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function checkTables() {
  console.log('=== Database Status Check ===\n')

  // Check main trader_snapshots table
  console.log('📊 trader_snapshots:')
  const { data: snapshots, count: snapshotCount } = await supabase
    .from('trader_snapshots')
    .select('source, season_id', { count: 'exact' })
    .limit(5000)

  if (snapshots && snapshots.length > 0) {
    const stats = {}
    snapshots.forEach(r => {
      const key = `${r.source}|${r.season_id}`
      stats[key] = (stats[key] || 0) + 1
    })
    Object.entries(stats).sort().forEach(([k, v]) => {
      const [source, period] = k.split('|')
      console.log(`  ${source.padEnd(18)} ${period.padEnd(5)} : ${v} 条`)
    })
    console.log(`  Total: ${snapshotCount || snapshots.length}`)
  } else {
    console.log('  (无数据)')
  }

  // Check one sample row
  console.log('\n📌 Sample trader_snapshots row:')
  const { data: sampleRow } = await supabase
    .from('trader_snapshots')
    .select('*')
    .limit(1)
    .single()

  if (sampleRow) {
    console.log('  Columns:', Object.keys(sampleRow).join(', '))
    console.log('  Sample:', JSON.stringify(sampleRow, null, 2).slice(0, 500))
  }

  // Try to get table list from information_schema
  console.log('\n📋 Tables containing "trader":')
  const { data: tables, error: tableError } = await supabase
    .rpc('get_tables_list')
    .catch(() => ({ data: null, error: 'RPC not available' }))

  if (tableError) {
    // Try direct query on common table names
    const tableNames = [
      'trader_snapshots',
      'trader_stats_detail',
      'trader_equity_curve',
      'trader_asset_breakdown',
      'trader_position_history',
      'trader_portfolio',
      'traders'
    ]

    for (const tableName of tableNames) {
      const { count, error } = await supabase
        .from(tableName)
        .select('*', { count: 'exact', head: true })

      if (!error) {
        console.log(`  ${tableName}: ${count} rows`)
      } else if (!error.message?.includes('does not exist')) {
        console.log(`  ${tableName}: error - ${error.message}`)
      }
    }
  }

  console.log('\n✅ 检查完成')
}

checkTables().catch(console.error)
