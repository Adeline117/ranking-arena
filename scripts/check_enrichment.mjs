#!/usr/bin/env node
/**
 * Read-only enrichment inventory.
 *
 * This reports the current public enrichment relations for forensic/operator
 * inventory only. It is not proof that an enrichment row is current, belongs
 * to a published ranking cohort, or may be served as a ranking metric.
 *
 * Usage:
 *   node scripts/check_enrichment.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '../.env.local')
const SAMPLE_LIMIT = 5_000

function loadEnvFileIfPresent(path) {
  if (!existsSync(path)) return

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

function requiredConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required'
    )
  }

  return { url, serviceRoleKey }
}

function stringCell(value, fallback = 'unknown') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function summarizeBySourceAndPeriod(rows) {
  const counts = new Map()

  for (const row of rows) {
    const source = stringCell(row.source)
    const period = stringCell(row.period, 'null')
    const key = `${source}\u0000${period}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [source, period] = key.split('\u0000')
      return { source, period, count }
    })
    .sort((left, right) =>
      left.source === right.source
        ? left.period.localeCompare(right.period)
        : left.source.localeCompare(right.source)
    )
}

function printSourcePeriodInventory(rows) {
  if (rows.length === 0) {
    console.log('  (no rows returned)')
    return
  }

  for (const { source, period, count } of summarizeBySourceAndPeriod(rows)) {
    console.log(`  ${source.padEnd(18)} ${period.padEnd(8)} : ${count} rows`)
  }
}

function queryError(label, error) {
  if (!error) return
  throw new Error(`${label} query failed: ${error.message}`)
}

function printFieldCoverage(rows) {
  if (rows.length === 0) {
    console.log('  (no rows returned)')
    return
  }

  const fields = ['avg_profit', 'avg_loss', 'sharpe_ratio', 'volatility', 'avg_holding_time_hours']
  const bySource = new Map()

  for (const row of rows) {
    const source = stringCell(row.source)
    const summary = bySource.get(source) || {
      total: 0,
      fields: Object.fromEntries(fields.map((f) => [f, 0])),
    }
    summary.total += 1
    for (const field of fields) {
      if (row[field] != null) summary.fields[field] += 1
    }
    bySource.set(source, summary)
  }

  for (const [source, summary] of [...bySource.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    console.log(`  ${source}:`)
    for (const field of fields) {
      const count = summary.fields[field]
      const percentage = ((count / summary.total) * 100).toFixed(0)
      console.log(`    ${field}: ${count}/${summary.total} (${percentage}%)`)
    }
  }
}

export async function runEnrichmentInventory(supabase) {
  console.log('=== Enrichment Inventory (non-authoritative) ===')
  console.log(`Sampling at most ${SAMPLE_LIMIT.toLocaleString()} rows per relation.\n`)

  console.log('📊 trader_stats_detail by source × period:')
  const { data: statsDetail, error: statsDetailError } = await supabase
    .from('trader_stats_detail')
    .select('source, period')
    .limit(SAMPLE_LIMIT)
  queryError('trader_stats_detail', statsDetailError)
  printSourcePeriodInventory(statsDetail || [])

  console.log('\n📈 trader_equity_curve by source × period:')
  const { data: equityCurve, error: equityCurveError } = await supabase
    .from('trader_equity_curve')
    .select('source, period')
    .limit(SAMPLE_LIMIT)
  queryError('trader_equity_curve', equityCurveError)
  printSourcePeriodInventory(equityCurve || [])

  console.log('\n💰 trader_asset_breakdown by source × period:')
  const { data: assetBreakdown, error: assetBreakdownError } = await supabase
    .from('trader_asset_breakdown')
    .select('source, period')
    .limit(SAMPLE_LIMIT)
  queryError('trader_asset_breakdown', assetBreakdownError)
  printSourcePeriodInventory(assetBreakdown || [])

  console.log('\n🔍 trader_stats_detail field coverage:')
  const { data: detailFields, error: detailFieldsError } = await supabase
    .from('trader_stats_detail')
    .select('source, avg_profit, avg_loss, sharpe_ratio, volatility, avg_holding_time_hours')
    .limit(SAMPLE_LIMIT)
  queryError('trader_stats_detail field coverage', detailFieldsError)
  printFieldCoverage(detailFields || [])

  console.log('\nResult: COMPLETE (inventory only; not publication/freshness proof)')
}

async function main() {
  loadEnvFileIfPresent(envPath)
  const { url, serviceRoleKey } = requiredConfig()
  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  await runEnrichmentInventory(supabase)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nResult: ERROR — ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
