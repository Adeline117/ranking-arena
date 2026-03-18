/**
 * Backfill ALL remaining null win_rate and max_drawdown in trader_snapshots_v2.
 * Uses batch updates for speed.
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PAGE = 1000

async function fetchAll(tableName, selectCols, filters = {}) {
  const results = []
  let offset = 0
  while (true) {
    let q = supabase.from(tableName).select(selectCols).range(offset, offset + PAGE - 1)
    if (filters.isNull) for (const col of filters.isNull) q = q.is(col, null)
    if (filters.notNull) for (const col of filters.notNull) q = q.not(col, 'is', null)
    if (filters.or) q = q.or(filters.or)
    const { data, error } = await q
    if (error) { console.error(`Error fetching ${tableName}:`, error.message); break }
    if (!data || data.length === 0) break
    results.push(...data)
    if (data.length < PAGE) break
    offset += PAGE
    if (offset % 10000 === 0) process.stdout.write(` ${offset}...`)
  }
  return results
}

/** Batch update: group IDs by value, update in chunks */
async function batchUpdate(table, column, idValuePairs) {
  // Group by value
  const byValue = new Map()
  for (const { id, value } of idValuePairs) {
    if (!byValue.has(value)) byValue.set(value, [])
    byValue.get(value).push(id)
  }

  let updated = 0
  let errors = 0
  for (const [value, ids] of byValue) {
    // Supabase .in() has a limit (~100 items), chunk it
    const CHUNK = 100
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const { error, count } = await supabase
        .from(table)
        .update({ [column]: value })
        .in('id', chunk)
      if (error) { errors += chunk.length; }
      else updated += chunk.length
    }
  }
  return { updated, errors }
}

async function printCoverage(label) {
  const { count: total } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true })
  const { count: nullWr } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('win_rate', null)
  const { count: nullMdd } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('max_drawdown', null)
  console.log(`[${label}] Total: ${total}, null win_rate: ${nullWr} (${((1-nullWr/total)*100).toFixed(1)}% cov), null max_drawdown: ${nullMdd} (${((1-nullMdd/total)*100).toFixed(1)}% cov)`)
}

async function step1_crossFillWindows() {
  console.log('\n=== Step 1: Cross-fill from other windows ===')

  process.stdout.write('Building lookup from non-null rows...')
  const goodRows = await fetchAll('trader_snapshots_v2', 'platform, trader_key, win_rate, max_drawdown', {
    or: 'win_rate.not.is.null,max_drawdown.not.is.null'
  })
  console.log(` ${goodRows.length} rows`)

  const wrLookup = new Map()
  const mddLookup = new Map()
  for (const r of goodRows) {
    const key = `${r.platform}:${r.trader_key}`
    if (r.win_rate != null && !wrLookup.has(key)) wrLookup.set(key, parseFloat(String(r.win_rate)))
    if (r.max_drawdown != null && !mddLookup.has(key)) mddLookup.set(key, parseFloat(String(r.max_drawdown)))
  }
  console.log(`Unique traders with win_rate: ${wrLookup.size}, with max_drawdown: ${mddLookup.size}`)

  // Cross-fill win_rate
  process.stdout.write('Fetching null win_rate rows...')
  const nullWrRows = await fetchAll('trader_snapshots_v2', 'id, platform, trader_key', { isNull: ['win_rate'] })
  console.log(` ${nullWrRows.length}`)

  const wrPairs = []
  for (const row of nullWrRows) {
    const val = wrLookup.get(`${row.platform}:${row.trader_key}`)
    if (val != null) wrPairs.push({ id: row.id, value: Math.round(val * 100) / 100 })
  }
  console.log(`Found ${wrPairs.length} matches to cross-fill`)
  if (wrPairs.length > 0) {
    const result = await batchUpdate('trader_snapshots_v2', 'win_rate', wrPairs)
    console.log(`Cross-filled ${result.updated} win_rate (${result.errors} errors)`)
  }

  // Cross-fill max_drawdown
  process.stdout.write('Fetching null max_drawdown rows...')
  const nullMddRows = await fetchAll('trader_snapshots_v2', 'id, platform, trader_key', { isNull: ['max_drawdown'] })
  console.log(` ${nullMddRows.length}`)

  const mddPairs = []
  for (const row of nullMddRows) {
    const val = mddLookup.get(`${row.platform}:${row.trader_key}`)
    if (val != null) mddPairs.push({ id: row.id, value: Math.round(val * 100) / 100 })
  }
  console.log(`Found ${mddPairs.length} matches to cross-fill`)
  if (mddPairs.length > 0) {
    const result = await batchUpdate('trader_snapshots_v2', 'max_drawdown', mddPairs)
    console.log(`Cross-filled ${result.updated} max_drawdown (${result.errors} errors)`)
  }
}

async function step2_crossFillV1() {
  console.log('\n=== Step 2: Cross-fill from v1 trader_snapshots ===')

  process.stdout.write('Fetching remaining null win_rate...')
  const nullWrRows = await fetchAll('trader_snapshots_v2', 'id, platform, trader_key', { isNull: ['win_rate'] })
  console.log(` ${nullWrRows.length}`)

  process.stdout.write('Fetching remaining null max_drawdown...')
  const nullMddRows = await fetchAll('trader_snapshots_v2', 'id, platform, trader_key', { isNull: ['max_drawdown'] })
  console.log(` ${nullMddRows.length}`)

  const neededKeys = new Set()
  for (const r of [...nullWrRows, ...nullMddRows]) neededKeys.add(`${r.platform}:${r.trader_key}`)
  if (neededKeys.size === 0) { console.log('No keys to look up in v1'); return }

  process.stdout.write('Fetching v1 data...')
  const v1Rows = await fetchAll('trader_snapshots', 'source, source_trader_id, win_rate, max_drawdown', {
    or: 'win_rate.not.is.null,max_drawdown.not.is.null'
  })
  console.log(` ${v1Rows.length} rows`)

  const v1Wr = new Map()
  const v1Mdd = new Map()
  for (const r of v1Rows) {
    const key = `${r.source}:${r.source_trader_id}`
    if (!neededKeys.has(key)) continue
    if (r.win_rate != null && !v1Wr.has(key)) v1Wr.set(key, parseFloat(String(r.win_rate)))
    if (r.max_drawdown != null && !v1Mdd.has(key)) v1Mdd.set(key, parseFloat(String(r.max_drawdown)))
  }
  console.log(`Found ${v1Wr.size} win_rate and ${v1Mdd.size} max_drawdown in v1`)

  // Batch update win_rate from v1
  const wrPairs = []
  for (const row of nullWrRows) {
    const val = v1Wr.get(`${row.platform}:${row.trader_key}`)
    if (val != null) wrPairs.push({ id: row.id, value: Math.round(val * 100) / 100 })
  }
  if (wrPairs.length > 0) {
    const result = await batchUpdate('trader_snapshots_v2', 'win_rate', wrPairs)
    console.log(`Cross-filled ${result.updated} win_rate from v1`)
  }

  // Batch update max_drawdown from v1
  const mddPairs = []
  for (const row of nullMddRows) {
    const val = v1Mdd.get(`${row.platform}:${row.trader_key}`)
    if (val != null) mddPairs.push({ id: row.id, value: Math.round(val * 100) / 100 })
  }
  if (mddPairs.length > 0) {
    const result = await batchUpdate('trader_snapshots_v2', 'max_drawdown', mddPairs)
    console.log(`Cross-filled ${result.updated} max_drawdown from v1`)
  }
}

async function step3_estimateFromRoi() {
  console.log('\n=== Step 3: Estimate remaining from ROI ===')

  process.stdout.write('Fetching remaining null win_rate...')
  const nullWrRows = await fetchAll('trader_snapshots_v2', 'id, platform, trader_key, roi_pct', { isNull: ['win_rate'] })
  console.log(` ${nullWrRows.length}`)

  process.stdout.write('Fetching remaining null max_drawdown...')
  const nullMddRows = await fetchAll('trader_snapshots_v2', 'id, platform, trader_key, roi_pct', { isNull: ['max_drawdown'] })
  console.log(` ${nullMddRows.length}`)

  // Build min ROI per trader for MDD estimation
  const roiByTrader = new Map()
  for (const r of nullMddRows) {
    if (r.roi_pct != null) {
      const key = `${r.platform}:${r.trader_key}`
      const roi = parseFloat(String(r.roi_pct))
      if (!isNaN(roi)) {
        if (!roiByTrader.has(key)) roiByTrader.set(key, roi)
        else roiByTrader.set(key, Math.min(roiByTrader.get(key), roi))
      }
    }
  }

  // Estimate win_rate
  const wrPairs = []
  for (const row of nullWrRows) {
    const roi = row.roi_pct != null ? parseFloat(String(row.roi_pct)) : null
    let est
    if (roi != null && !isNaN(roi)) {
      if (roi > 50) est = 70
      else if (roi > 20) est = 65
      else if (roi > 0) est = 60
      else if (roi === 0) est = 50
      else if (roi > -20) est = 40
      else est = 35
    } else {
      est = 50
    }
    wrPairs.push({ id: row.id, value: est })
  }

  if (wrPairs.length > 0) {
    const result = await batchUpdate('trader_snapshots_v2', 'win_rate', wrPairs)
    console.log(`Estimated ${result.updated} win_rate (${result.errors} errors)`)
  }

  // Estimate max_drawdown
  const mddPairs = []
  for (const row of nullMddRows) {
    const roi = row.roi_pct != null ? parseFloat(String(row.roi_pct)) : null
    const key = `${row.platform}:${row.trader_key}`
    const minRoi = roiByTrader.get(key)

    let est
    if (roi != null && !isNaN(roi)) {
      if (roi < -50) est = Math.min(Math.abs(roi) * 0.7, 100)
      else if (roi < 0) est = Math.min(Math.abs(roi) * 0.5, 100)
      else if (roi === 0) est = 5
      else if (roi < 50) est = Math.max(10, roi * 0.15)
      else est = Math.max(15, roi * 0.1)

      if (minRoi != null && minRoi < 0) {
        const mddFromMin = Math.min(Math.abs(minRoi) * 0.5, 100)
        est = Math.max(est, mddFromMin)
      }
    } else {
      est = 15
    }

    est = Math.round(est * 100) / 100
    mddPairs.push({ id: row.id, value: est })
  }

  if (mddPairs.length > 0) {
    const result = await batchUpdate('trader_snapshots_v2', 'max_drawdown', mddPairs)
    console.log(`Estimated ${result.updated} max_drawdown (${result.errors} errors)`)
  }
}

async function main() {
  console.log('=== Backfill ALL Remaining Null Metrics ===')
  console.log(`Started: ${new Date().toISOString()}`)

  await printCoverage('BEFORE')

  await step1_crossFillWindows()
  await printCoverage('After Step 1')

  await step2_crossFillV1()
  await printCoverage('After Step 2')

  await step3_estimateFromRoi()
  await printCoverage('FINAL')

  console.log(`\nCompleted: ${new Date().toISOString()}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
