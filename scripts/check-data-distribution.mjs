#!/usr/bin/env node
/**
 * 检查各表数据分布 - 使用 fetch 直接调用 Supabase REST API
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 读取 .env.local
function loadEnv() {
  const envPath = join(__dirname, '..', '.env.local')
  const content = readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const match = line.match(/^([^=]+)=["']?(.+?)["']?$/)
    if (match) {
      process.env[match[1]] = match[2]
    }
  }
}

loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function queryTable(table, select = '*', params = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}`
  if (params.limit) url += `&limit=${params.limit}`
  if (params.order) url += `&order=${params.order}`

  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  })
  return res.json()
}

async function main() {
  console.log('=== 数据分布检查 ===\n')

  // 1. trader_equity_curve 分布
  console.log('📈 trader_equity_curve 按 source 和 period 分布:')
  const curveData = await queryTable('trader_equity_curve', 'source,period', { limit: 10000 })
  if (Array.isArray(curveData)) {
    const stats = {}
    curveData.forEach(r => {
      const key = `${r.source}|${r.period}`
      stats[key] = (stats[key] || 0) + 1
    })
    Object.entries(stats).sort().forEach(([k, v]) => {
      const [source, period] = k.split('|')
      console.log(`  ${source.padEnd(18)} ${period.padEnd(5)} : ${v}`)
    })
  } else {
    console.log('  Error:', curveData)
  }

  // 2. trader_stats_detail 分布
  console.log('\n📊 trader_stats_detail 按 source 和 period 分布:')
  const statsData = await queryTable('trader_stats_detail', 'source,period', { limit: 10000 })
  if (Array.isArray(statsData)) {
    const stats = {}
    statsData.forEach(r => {
      const key = `${r.source}|${r.period}`
      stats[key] = (stats[key] || 0) + 1
    })
    Object.entries(stats).sort().forEach(([k, v]) => {
      const [source, period] = k.split('|')
      console.log(`  ${source.padEnd(18)} ${period.padEnd(5)} : ${v}`)
    })
  } else {
    console.log('  Error:', statsData)
  }

  // 3. sharpe_ratio 在 stats_detail 中的填充率
  console.log('\n🎯 trader_stats_detail sharpe_ratio 填充率:')
  const sharpeData = await queryTable('trader_stats_detail', 'source,sharpe_ratio', { limit: 10000 })
  if (Array.isArray(sharpeData)) {
    const stats = {}
    sharpeData.forEach(r => {
      if (!stats[r.source]) stats[r.source] = { total: 0, has_sharpe: 0 }
      stats[r.source].total++
      if (r.sharpe_ratio != null) stats[r.source].has_sharpe++
    })
    Object.entries(stats).sort().forEach(([source, s]) => {
      const pct = s.total > 0 ? (s.has_sharpe / s.total * 100).toFixed(0) : 0
      console.log(`  ${source.padEnd(18)}: ${s.has_sharpe}/${s.total} (${pct}%)`)
    })
  }

  // 4. 最近更新时间
  console.log('\n⏰ 最近更新时间:')

  const latestCurve = await queryTable('trader_equity_curve', 'source,captured_at', { limit: 100, order: 'captured_at.desc' })
  if (Array.isArray(latestCurve)) {
    const bySource = {}
    latestCurve.forEach(r => {
      if (!bySource[r.source]) bySource[r.source] = r.captured_at
    })
    console.log('  trader_equity_curve:')
    Object.entries(bySource).forEach(([source, time]) => {
      const ago = Math.round((Date.now() - new Date(time).getTime()) / (1000 * 60 * 60))
      console.log(`    ${source.padEnd(18)}: ${ago}h 前`)
    })
  }

  const latestStats = await queryTable('trader_stats_detail', 'source,captured_at', { limit: 100, order: 'captured_at.desc' })
  if (Array.isArray(latestStats)) {
    const bySource = {}
    latestStats.forEach(r => {
      if (!bySource[r.source]) bySource[r.source] = r.captured_at
    })
    console.log('  trader_stats_detail:')
    Object.entries(bySource).forEach(([source, time]) => {
      const ago = Math.round((Date.now() - new Date(time).getTime()) / (1000 * 60 * 60))
      console.log(`    ${source.padEnd(18)}: ${ago}h 前`)
    })
  }

  // 5. trader_snapshots_v2 sharpe_ratio 填充率
  console.log('\n📉 trader_snapshots_v2 sharpe_ratio 填充率:')
  const snapshotsData = await queryTable('trader_snapshots_v2', 'platform,sharpe_ratio', { limit: 10000 })
  if (Array.isArray(snapshotsData)) {
    const stats = {}
    snapshotsData.forEach(r => {
      if (!stats[r.platform]) stats[r.platform] = { total: 0, has_sharpe: 0 }
      stats[r.platform].total++
      if (r.sharpe_ratio != null) stats[r.platform].has_sharpe++
    })
    Object.entries(stats).sort().forEach(([platform, s]) => {
      const pct = s.total > 0 ? (s.has_sharpe / s.total * 100).toFixed(0) : 0
      console.log(`  ${platform.padEnd(18)}: ${s.has_sharpe}/${s.total} (${pct}%)`)
    })
  }

  console.log('\n完成')
}

main().catch(console.error)
