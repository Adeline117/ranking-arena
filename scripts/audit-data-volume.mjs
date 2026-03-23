/**
 * Task 1 & 2: Data Volume Matrix + Data Quality Audit
 * Queries leaderboard_ranks AND trader_snapshots for comprehensive audit.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SEASONS = ['7D', '30D', '90D']

const ON_CHAIN_SOURCES = [
  'hyperliquid', 'gmx', 'dydx', 'jupiter_perps', 'drift', 'gains', 'kwenta', 'aevo', 'copin',
  'binance_web3', 'okx_web3'
]
const SPOT_SUFFIXES = ['_spot']

function getCategory(source) {
  if (ON_CHAIN_SOURCES.includes(source)) return 'On-chain'
  for (const s of SPOT_SUFFIXES) {
    if (source.endsWith(s)) return 'Spot'
  }
  return 'Futures'
}

function padRight(str, len) {
  return String(str).padEnd(len)
}

async function task1_volumeMatrix() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  TASK 1: DATA VOLUME MATRIX                            ║')
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  // --- leaderboard_ranks ---
  console.log('=== leaderboard_ranks (what users see) ===\n')

  const countMap = new Map()
  const allSources = new Set()

  // Get all data from leaderboard_ranks grouped
  for (const season of SEASONS) {
    const { data } = await supabase
      .from('leaderboard_ranks')
      .select('source')
      .eq('season_id', season)
      .limit(50000)

    if (!data) continue
    const sourceCounts = {}
    for (const row of data) {
      sourceCounts[row.source] = (sourceCounts[row.source] || 0) + 1
      allSources.add(row.source)
    }
    for (const [source, cnt] of Object.entries(sourceCounts)) {
      countMap.set(`${source}:${season}`, cnt)
    }
  }

  const sortedSources = [...allSources].sort()

  console.log(padRight('Exchange', 25) + SEASONS.map(s => padRight(s, 10)).join('') + 'Total')
  console.log('-'.repeat(65))

  let poorExperience = []
  for (const source of sortedSources) {
    let row = padRight(source, 25)
    let total = 0
    for (const season of SEASONS) {
      const count = countMap.get(`${source}:${season}`) || 0
      total += count
      const flag = count < 100 ? ' !!' : ''
      row += padRight(`${count}${flag}`, 10)
      if (count < 100) poorExperience.push({ source, season, count })
    }
    row += total
    console.log(row)
  }

  // Category matrix
  console.log('\n--- Category Aggregates ---')
  console.log(padRight('Category', 25) + SEASONS.map(s => padRight(s, 10)).join(''))
  console.log('-'.repeat(55))
  for (const cat of ['All', 'Futures', 'Spot', 'On-chain']) {
    let row = padRight(cat, 25)
    for (const season of SEASONS) {
      let total = 0
      for (const source of sortedSources) {
        if (cat === 'All' || getCategory(source) === cat) {
          total += countMap.get(`${source}:${season}`) || 0
        }
      }
      const flag = total < 100 ? ' !!' : ''
      row += padRight(`${total}${flag}`, 10)
    }
    console.log(row)
  }

  if (poorExperience.length > 0) {
    console.log(`\n--- Poor Experience (<100 rows in leaderboard_ranks) ---`)
    for (const { source, season, count } of poorExperience) {
      console.log(`  ${source} x ${season}: ${count} rows`)
    }
  }

  // --- Now also check trader_snapshots (v1) which feeds into compute-leaderboard ---
  console.log('\n\n=== trader_snapshots (v1) - source data ===\n')

  const v1Map = new Map()
  const v1Sources = new Set()

  for (const season of SEASONS) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('source')
      .eq('season_id', season)
      .limit(50000)

    if (!data) continue
    const sourceCounts = {}
    for (const row of data) {
      sourceCounts[row.source] = (sourceCounts[row.source] || 0) + 1
      v1Sources.add(row.source)
    }
    for (const [source, cnt] of Object.entries(sourceCounts)) {
      v1Map.set(`${source}:${season}`, cnt)
    }
  }

  const v1Sorted = [...v1Sources].sort()
  console.log(padRight('Exchange', 25) + SEASONS.map(s => padRight(s, 10)).join('') + 'Total')
  console.log('-'.repeat(65))

  let v1Poor = []
  for (const source of v1Sorted) {
    let row = padRight(source, 25)
    let total = 0
    for (const season of SEASONS) {
      const count = v1Map.get(`${source}:${season}`) || 0
      total += count
      const flag = count < 100 ? ' !!' : ''
      row += padRight(`${count}${flag}`, 10)
      if (count < 100) v1Poor.push({ source, season, count })
    }
    row += total
    console.log(row)
  }

  // Category
  console.log('\n--- Category Aggregates (v1 snapshots) ---')
  console.log(padRight('Category', 25) + SEASONS.map(s => padRight(s, 10)).join(''))
  console.log('-'.repeat(55))
  for (const cat of ['All', 'Futures', 'Spot', 'On-chain']) {
    let row = padRight(cat, 25)
    for (const season of SEASONS) {
      let total = 0
      for (const source of v1Sorted) {
        if (cat === 'All' || getCategory(source) === cat) {
          total += v1Map.get(`${source}:${season}`) || 0
        }
      }
      const flag = total < 100 ? ' !!' : ''
      row += padRight(`${total}${flag}`, 10)
    }
    console.log(row)
  }

  if (v1Poor.length > 0) {
    console.log(`\n--- Poor Experience (<100 rows in v1 snapshots) ---`)
    for (const { source, season, count } of v1Poor) {
      console.log(`  ${source} x ${season}: ${count} rows`)
    }
  }

  console.log(`\nTotal exchanges in leaderboard_ranks: ${sortedSources.length}`)
  console.log(`Total exchanges in v1 snapshots: ${v1Sorted.length}`)
  console.log(`Missing from leaderboard (in v1 but not LR): ${v1Sorted.filter(s => !allSources.has(s)).join(', ') || 'none'}`)
}

async function task2_qualityAudit() {
  console.log('\n\n╔══════════════════════════════════════════════════════════╗')
  console.log('║  TASK 2: DATA QUALITY AUDIT                             ║')
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  // Get all sources
  const { data: srcData } = await supabase
    .from('trader_snapshots')
    .select('source')
    .limit(50000)

  const allSources = [...new Set(srcData?.map(r => r.source) || [])].sort()

  const issues = []

  for (const source of allSources) {
    const sourceIssues = { source, roiHigh: 0, roiLow: 0, mddHigh: 0, mddLow: 0, wrHigh: 0, wrLow: 0, pnlExtreme: 0, total: 0 }

    // Get all rows for this source
    const { data: rows } = await supabase
      .from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown')
      .eq('source', source)
      .limit(10000)

    if (!rows) continue
    sourceIssues.total = rows.length

    for (const row of rows) {
      // ROI anomalies
      if (row.roi != null && row.roi > 10000) sourceIssues.roiHigh++
      if (row.roi != null && row.roi < -100) sourceIssues.roiLow++

      // MDD anomalies
      if (row.max_drawdown != null && row.max_drawdown > 100) sourceIssues.mddHigh++
      if (row.max_drawdown != null && row.max_drawdown < 0) sourceIssues.mddLow++

      // Win rate anomalies
      if (row.win_rate != null && row.win_rate > 100) sourceIssues.wrHigh++
      if (row.win_rate != null && row.win_rate < 0) sourceIssues.wrLow++

      // Extreme PnL
      if (row.pnl != null && Math.abs(row.pnl) > 10000000) sourceIssues.pnlExtreme++
    }

    const hasIssues = sourceIssues.roiHigh + sourceIssues.roiLow + sourceIssues.mddHigh + sourceIssues.mddLow + sourceIssues.wrHigh + sourceIssues.wrLow + sourceIssues.pnlExtreme > 0
    if (hasIssues) {
      issues.push(sourceIssues)
    }
  }

  // Also audit trader_snapshots_v2
  const v2Issues = []
  const { data: v2SrcData } = await supabase
    .from('trader_snapshots_v2')
    .select('platform')
    .limit(50000)

  const v2Sources = [...new Set(v2SrcData?.map(r => r.platform) || [])].sort()

  for (const source of v2Sources) {
    const si = { source, roiHigh: 0, roiLow: 0, mddHigh: 0, mddLow: 0, wrHigh: 0, wrLow: 0, pnlExtreme: 0, total: 0 }

    const { data: rows } = await supabase
      .from('trader_snapshots_v2')
      .select('roi_pct, pnl_usd, win_rate, max_drawdown')
      .eq('platform', source)
      .limit(10000)

    if (!rows) continue
    si.total = rows.length

    for (const row of rows) {
      if (row.roi_pct != null && row.roi_pct > 10000) si.roiHigh++
      if (row.roi_pct != null && row.roi_pct < -100) si.roiLow++
      if (row.max_drawdown != null && row.max_drawdown > 100) si.mddHigh++
      if (row.max_drawdown != null && row.max_drawdown < 0) si.mddLow++
      if (row.win_rate != null && row.win_rate > 100) si.wrHigh++
      if (row.win_rate != null && row.win_rate < 0) si.wrLow++
      if (row.pnl_usd != null && Math.abs(row.pnl_usd) > 10000000) si.pnlExtreme++
    }

    if (si.roiHigh + si.roiLow + si.mddHigh + si.mddLow + si.wrHigh + si.wrLow + si.pnlExtreme > 0) {
      v2Issues.push(si)
    }
  }

  // Print results
  console.log('=== trader_snapshots (v1) Quality Issues ===\n')
  if (issues.length === 0) {
    console.log('No anomalies found!\n')
  } else {
    console.log(padRight('Exchange', 22) + padRight('Total', 8) + padRight('ROI>10k', 10) + padRight('ROI<-100', 10) + padRight('MDD>100', 10) + padRight('MDD<0', 8) + padRight('WR>100', 8) + padRight('WR<0', 8) + 'PnL>10M')
    console.log('-'.repeat(94))
    for (const i of issues) {
      console.log(
        padRight(i.source, 22) + padRight(i.total, 8) +
        padRight(i.roiHigh || '-', 10) + padRight(i.roiLow || '-', 10) +
        padRight(i.mddHigh || '-', 10) + padRight(i.mddLow || '-', 8) +
        padRight(i.wrHigh || '-', 8) + padRight(i.wrLow || '-', 8) +
        (i.pnlExtreme || '-')
      )
    }
  }

  if (v2Issues.length > 0) {
    console.log('\n=== trader_snapshots_v2 Quality Issues ===\n')
    console.log(padRight('Exchange', 22) + padRight('Total', 8) + padRight('ROI>10k', 10) + padRight('ROI<-100', 10) + padRight('MDD>100', 10) + padRight('MDD<0', 8) + padRight('WR>100', 8) + padRight('WR<0', 8) + 'PnL>10M')
    console.log('-'.repeat(94))
    for (const i of v2Issues) {
      console.log(
        padRight(i.source, 22) + padRight(i.total, 8) +
        padRight(i.roiHigh || '-', 10) + padRight(i.roiLow || '-', 10) +
        padRight(i.mddHigh || '-', 10) + padRight(i.mddLow || '-', 8) +
        padRight(i.wrHigh || '-', 8) + padRight(i.wrLow || '-', 8) +
        (i.pnlExtreme || '-')
      )
    }
  }

  // Return issues for Task 3
  return { v1Issues: issues, v2Issues }
}

async function main() {
  await task1_volumeMatrix()
  const qualityIssues = await task2_qualityAudit()

  console.log('\n\n=== SUMMARY ===')
  const allIssueExchanges = [...new Set([
    ...qualityIssues.v1Issues.map(i => i.source),
    ...qualityIssues.v2Issues.map(i => i.source),
  ])]
  if (allIssueExchanges.length > 0) {
    console.log(`Exchanges with quality issues: ${allIssueExchanges.join(', ')}`)
  } else {
    console.log('No data quality issues found across any exchange.')
  }
}

main().catch(console.error).finally(() => process.exit(0))
