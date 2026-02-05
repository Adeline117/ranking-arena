/**
 * Enrichment Data Validation Script
 * Checks data fill rates across all enrichment tables
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

async function checkData() {
  console.log('=== Enrichment Data Validation ===\n')

  // 1. Check trader_stats_detail
  console.log('📊 trader_stats_detail 数据统计:')
  const { data: statsDetail } = await supabase
    .from('trader_stats_detail')
    .select('source, season_id')

  if (statsDetail && statsDetail.length > 0) {
    const stats = {}
    statsDetail.forEach(r => {
      const key = `${r.source}|${r.season_id}`
      stats[key] = (stats[key] || 0) + 1
    })
    Object.entries(stats).sort().forEach(([k, v]) => {
      const [source, period] = k.split('|')
      console.log(`  ${source.padEnd(18)} ${period.padEnd(5)} : ${v} 条记录`)
    })
  } else {
    console.log('  (无数据)')
  }

  // 2. Check trader_equity_curve
  console.log('\n📈 trader_equity_curve 数据统计:')
  const { data: equityCurve } = await supabase
    .from('trader_equity_curve')
    .select('source, season_id')

  if (equityCurve && equityCurve.length > 0) {
    const stats = {}
    equityCurve.forEach(r => {
      const key = `${r.source}|${r.season_id}`
      stats[key] = (stats[key] || 0) + 1
    })
    Object.entries(stats).sort().forEach(([k, v]) => {
      const [source, period] = k.split('|')
      console.log(`  ${source.padEnd(18)} ${period.padEnd(5)} : ${v} 条记录`)
    })
  } else {
    console.log('  (无数据)')
  }

  // 3. Check trader_asset_breakdown
  console.log('\n💰 trader_asset_breakdown 数据统计:')
  const { data: assetBreakdown } = await supabase
    .from('trader_asset_breakdown')
    .select('source, season_id')

  if (assetBreakdown && assetBreakdown.length > 0) {
    const stats = {}
    assetBreakdown.forEach(r => {
      const key = `${r.source}|${r.season_id}`
      stats[key] = (stats[key] || 0) + 1
    })
    Object.entries(stats).sort().forEach(([k, v]) => {
      const [source, period] = k.split('|')
      console.log(`  ${source.padEnd(18)} ${period.padEnd(5)} : ${v} 条记录`)
    })
  } else {
    console.log('  (无数据)')
  }

  // 4. Check key fields in stats_detail
  console.log('\n🔍 trader_stats_detail 关键字段填充率:')
  const { data: detailFields } = await supabase
    .from('trader_stats_detail')
    .select('source, avg_profit, avg_loss, sharpe_ratio, volatility, avg_holding_time')
    .limit(2000)

  if (detailFields && detailFields.length > 0) {
    const fieldStats = {}
    detailFields.forEach(r => {
      if (!fieldStats[r.source]) {
        fieldStats[r.source] = { total: 0, avg_profit: 0, avg_loss: 0, sharpe_ratio: 0, volatility: 0, avg_holding_time: 0 }
      }
      fieldStats[r.source].total++
      if (r.avg_profit != null) fieldStats[r.source].avg_profit++
      if (r.avg_loss != null) fieldStats[r.source].avg_loss++
      if (r.sharpe_ratio != null) fieldStats[r.source].sharpe_ratio++
      if (r.volatility != null) fieldStats[r.source].volatility++
      if (r.avg_holding_time != null) fieldStats[r.source].avg_holding_time++
    })

    Object.entries(fieldStats).sort().forEach(([source, s]) => {
      console.log(`  ${source}:`)
      console.log(`    avg_profit: ${s.avg_profit}/${s.total} (${(s.avg_profit/s.total*100).toFixed(0)}%)`)
      console.log(`    avg_loss: ${s.avg_loss}/${s.total} (${(s.avg_loss/s.total*100).toFixed(0)}%)`)
      console.log(`    sharpe_ratio: ${s.sharpe_ratio}/${s.total} (${(s.sharpe_ratio/s.total*100).toFixed(0)}%)`)
      console.log(`    volatility: ${s.volatility}/${s.total} (${(s.volatility/s.total*100).toFixed(0)}%)`)
      console.log(`    avg_holding_time: ${s.avg_holding_time}/${s.total} (${(s.avg_holding_time/s.total*100).toFixed(0)}%)`)
    })
  } else {
    console.log('  (无数据)')
  }

  // 5. Check trader_snapshots sharpe_ratio
  console.log('\n📌 trader_snapshots sharpe_ratio 填充率:')
  const { data: snapshots } = await supabase
    .from('trader_snapshots')
    .select('source, sharpe_ratio')
    .limit(3000)

  if (snapshots && snapshots.length > 0) {
    const snapshotStats = {}
    snapshots.forEach(r => {
      if (!snapshotStats[r.source]) snapshotStats[r.source] = { total: 0, has_sharpe: 0 }
      snapshotStats[r.source].total++
      if (r.sharpe_ratio != null) snapshotStats[r.source].has_sharpe++
    })
    Object.entries(snapshotStats).sort().forEach(([source, s]) => {
      console.log(`  ${source.padEnd(18)}: ${s.has_sharpe}/${s.total} (${(s.has_sharpe/s.total*100).toFixed(0)}%)`)
    })
  } else {
    console.log('  (无数据)')
  }

  console.log('\n✅ 数据验证完成')
}

checkData().catch(console.error)
