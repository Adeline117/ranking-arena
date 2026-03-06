#!/usr/bin/env node
/**
 * Pipeline status overview: data freshness, cron health, and key counts.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '../.env.local')

try {
  for (const l of readFileSync(envPath, 'utf8').split('\n')) {
    const m = l.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function hoursAgo(dateStr) {
  return Math.round((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60))
}

function freshIcon(hours) {
  if (hours <= 4) return 'OK'
  if (hours <= 12) return 'WARN'
  return 'STALE'
}

async function checkStatus() {
  console.log('=== Pipeline Status Overview ===\n')

  // 1. Key table counts
  console.log('--- Table Counts ---')
  const tables = ['trader_sources', 'trader_snapshots', 'trader_stats_detail', 'trader_equity_curve']
  for (const table of tables) {
    const { count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
    if (error) {
      console.log(`  ${table}: error - ${error.message}`)
    } else {
      console.log(`  ${table}: ${(count ?? 0).toLocaleString()} rows`)
    }
  }

  // 2. Data freshness per source
  console.log('\n--- Data Freshness (trader_snapshots) ---')

  const { data: snapshots, error: snapErr } = await supabase
    .from('trader_snapshots')
    .select('source')
    .limit(50000)

  if (snapErr) {
    console.error('Error:', snapErr.message)
    process.exit(1)
  }

  const sourceCounts = {}
  snapshots?.forEach(r => {
    sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1
  })

  const sources = Object.keys(sourceCounts).sort()
  let freshCount = 0
  let warnCount = 0
  let staleCount = 0

  const colSrc = 20
  const colCnt = 8
  const colAge = 12
  const colSt = 6
  console.log('  ' + 'Source'.padEnd(colSrc) + 'Count'.padStart(colCnt) + 'Age'.padStart(colAge) + 'Status'.padStart(colSt))
  console.log('  ' + '-'.repeat(colSrc + colCnt + colAge + colSt))

  for (const source of sources) {
    const { data: latest } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .eq('source', source)
      .order('captured_at', { ascending: false })
      .limit(1)

    const age = latest?.[0] ? hoursAgo(latest[0].captured_at) : -1
    const status = age < 0 ? '?' : freshIcon(age)
    const ageStr = age < 0 ? 'unknown' : `${age}h ago`

    if (status === 'OK') freshCount++
    else if (status === 'WARN') warnCount++
    else staleCount++

    console.log(
      '  ' +
      source.padEnd(colSrc) +
      String(sourceCounts[source]).padStart(colCnt) +
      ageStr.padStart(colAge) +
      status.padStart(colSt)
    )
  }

  // 3. Recent cron activity
  console.log('\n--- Recent Cron Activity ---')
  const { data: cronLogs, error: cronErr } = await supabase
    .from('cron_logs')
    .select('name, ran_at, result')
    .order('ran_at', { ascending: false })
    .limit(20)

  if (cronErr) {
    console.log(`  cron_logs: ${cronErr.message}`)
  } else if (!cronLogs || cronLogs.length === 0) {
    console.log('  No recent cron logs found.')
  } else {
    for (const log of cronLogs.slice(0, 10)) {
      const age = hoursAgo(log.ran_at)
      let status = 'ok'
      try {
        const r = typeof log.result === 'string' ? JSON.parse(log.result) : log.result
        if (Array.isArray(r) && r.some(x => !x.success)) status = 'partial'
        if (r?.error) status = 'fail'
      } catch {}
      console.log(`  ${age}h ago  ${status.padEnd(8)} ${log.name}`)
    }
  }

  // 4. Summary
  console.log('\n--- Summary ---')
  console.log(`  Platforms: ${sources.length}`)
  console.log(`  Fresh (<4h): ${freshCount}  |  Warning (4-12h): ${warnCount}  |  Stale (>12h): ${staleCount}`)

  if (staleCount > 0) {
    console.log('\n  Action needed: some platforms have stale data (>12h).')
  } else if (warnCount > 0) {
    console.log('\n  Some platforms approaching staleness.')
  } else {
    console.log('\n  All platforms up to date.')
  }

  console.log('\nDone.')
}

checkStatus().catch(e => {
  console.error(e)
  process.exit(1)
})
