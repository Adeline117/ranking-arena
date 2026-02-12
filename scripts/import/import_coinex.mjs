/**
 * CoinEx Copy Trading 排行榜数据抓取 (API版本)
 * 
 * 使用 CoinEx 内部 API 直接获取数据，无需浏览器
 * API: /res/copy-trading/public/traders
 * 
 * 用法: node scripts/import/import_coinex.mjs [7D|30D|90D|ALL]
 */

import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'coinex'
const API_BASE = 'https://www.coinex.com/res/copy-trading/public/traders'
const TARGET_COUNT = 500
const PAGE_SIZE = 100

// Map our period names to CoinEx API time_range values
const PERIOD_MAP = {
  '7D': 'DAY7',
  '30D': 'DAY30',
  '90D': 'DAY90',
}

async function fetchPage(timeRange, page) {
  const url = `${API_BASE}?data_type=profit_rate&time_range=${timeRange}&hide_full=0&page=${page}&limit=${PAGE_SIZE}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (json.code !== 0) throw new Error(`API error: ${json.code} ${json.message}`)
  return json.data
}

async function fetchLeaderboardData(period) {
  const timeRange = PERIOD_MAP[period]
  if (!timeRange) {
    console.log(`  ⚠ Unknown period: ${period}`)
    return []
  }
  
  console.log(`\n=== 抓取 CoinEx ${period} (${timeRange}) 排行榜 ===`)
  console.log('时间:', new Date().toISOString())

  const allTraders = []
  let page = 1

  while (allTraders.length < TARGET_COUNT) {
    const data = await fetchPage(timeRange, page)
    if (!data.data || data.data.length === 0) break
    
    for (const t of data.data) {
      allTraders.push({
        traderId: t.trader_id,
        nickname: t.nickname || t.account_name || t.trader_id,
        avatar: t.avatar || null,
        roi: parseFloat(t.profit_rate || 0) * 100, // API returns decimal, convert to %
        pnl: parseFloat(t.profit_amount || 0),
        winRate: parseFloat(t.winning_rate || 0) * 100,
        maxDrawdown: parseFloat(t.mdd || 0) * 100,
        followers: t.cur_follower_num || 0,
        aum: parseFloat(t.aum || 0),
      })
    }
    
    console.log(`  第${page}页: ${data.data.length} 个, 累计 ${allTraders.length}`)
    
    if (!data.has_next) break
    page++
    await sleep(300) // gentle rate limit
  }

  console.log(`📊 共获取 ${allTraders.length} 个交易员数据`)
  return allTraders
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员...`)
  
  const capturedAt = new Date().toISOString()
  let saved = 0, errors = 0

  // Batch upsert trader_sources
  const sources = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    is_active: true,
  }))
  
  // Upsert in chunks of 100
  for (let i = 0; i < sources.length; i += 100) {
    const chunk = sources.slice(i, i + 100)
    await supabase.from('trader_sources').upsert(chunk, { onConflict: 'source,source_trader_id' })
  }

  // Batch upsert snapshots
  const snapshots = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl || null,
    win_rate: t.winRate || null,
    max_drawdown: t.maxDrawdown || null,
    followers: t.followers || 0,
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore,
    captured_at: capturedAt,
  }))

  for (let i = 0; i < snapshots.length; i += 100) {
    const chunk = snapshots.slice(i, i + 100)
    const { error } = await supabase.from('trader_snapshots').upsert(chunk, { onConflict: 'source,source_trader_id,season_id' })
    if (error) {
      console.log(`  ⚠ Batch error:`, error.message)
      errors += chunk.length
    } else {
      saved += chunk.length
    }
  }

  console.log(`  ✓ 保存: ${saved}, 失败: ${errors}`)
  return { saved, errors }
}

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`CoinEx 数据抓取 (API版本)`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`========================================`)

  const results = []

  for (const period of periods) {
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log(`\n⚠ ${period} 未获取到数据，跳过`)
      continue
    }

    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    traders.forEach((t, idx) => t.rank = idx + 1)

    const top = traders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10:`)
    top.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
    })

    const result = await saveTraders(top, period)
    results.push({ period, count: top.length, topRoi: top[0]?.roi || 0 })
    
    if (periods.indexOf(period) < periods.length - 1) {
      await sleep(1000)
    }
  }
  
  const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ 全部完成！`)
  console.log(`${'='.repeat(60)}`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.count} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
