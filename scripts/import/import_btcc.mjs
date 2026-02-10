/**
 * BTCC Copy Trading 排行榜数据抓取
 * 
 * API: POST https://www.btcc.com/documentary/trader/page
 * 数据源: BTCC官方跟单排行榜
 * 
 * 用法: node scripts/import/import_btcc.mjs [7D|30D|90D|ALL]
 */

import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'btcc'
const API_URL = 'https://www.btcc.com/documentary/trader/page'
const PROFILE_BASE = 'https://www.btcc.com/en-US/copy-trading'
const TARGET_COUNT = 200 // API returns max ~20 per sort, we collect across multiple sorts
const REQUEST_DELAY = 800

const HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.btcc.com/en-US/copy-trading',
}

// sortField 选项: overall, totalNetProfit, rateProfit, winRate, followNum
const SORT_OPTIONS = ['overall', 'rateProfit', 'totalNetProfit', 'winRate']

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 BTCC ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  
  const traders = new Map()
  
  for (const sortField of SORT_OPTIONS) {
    console.log(`\n  🔍 按 ${sortField} 排序获取...`)
    
    // BTCC API doesn't support real pagination - returns same top 20 regardless of pageNo
    // We just fetch once per sort field to collect as many unique traders as possible
    try {
      const body = {
        pageNo: 1,
        pageSize: 50,
        sortField,
        sortType: 1, // 1 = desc
      }
      
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      })
      
      if (!resp.ok) {
        console.log(`    ⚠ HTTP ${resp.status}`)
        continue
      }
      
      const data = await resp.json()
      const rows = data?.rows || []
      const before = traders.size
      
      for (const item of rows) {
        const id = String(item.traderId)
        if (traders.has(id)) continue
        
        traders.set(id, {
          traderId: id,
          nickname: item.nickName || `Trader-${id}`,
          avatar: item.avatarPic || null,
          roi: parseFloat(item.rateProfit || 0),
          pnl: parseFloat(item.totalNetProfit || 0),
          winRate: parseFloat(item.winRate || 0),
          maxDrawdown: parseFloat(item.maxBackRate || 0),
          followers: parseInt(item.followNum || 0),
        })
      }
      
      console.log(`    获取 ${rows.length} 个, 新增 ${traders.size - before}, 累计 ${traders.size}`)
      await sleep(REQUEST_DELAY)
    } catch (e) {
      console.log(`    ⚠ 错误: ${e.message}`)
    }
  }
  
  console.log(`\n📊 共获取 ${traders.size} 个交易员`)
  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员 (${period})...`)
  
  const capturedAt = new Date().toISOString()
  
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'copy_trading',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar,
    is_active: true,
  }))
  
  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: t.followers,
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore,
    captured_at: capturedAt,
  }))
  
  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, { onConflict: 'source,source_trader_id,season_id' })
  
  if (error) {
    console.log(`  ⚠ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!e) saved++
    }
    console.log(`  逐条保存: ${saved}/${snapshotsData.length}`)
    return { saved, errors: snapshotsData.length - saved }
  }
  
  console.log(`  ✓ 保存成功: ${snapshotsData.length}`)
  return { saved: snapshotsData.length, errors: 0 }
}

async function main() {
  const periods = getTargetPeriods()
  const startTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`BTCC Copy Trading 数据抓取`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`========================================`)
  
  const results = []
  
  for (const period of periods) {
    const traders = await fetchLeaderboardData(period)
    
    if (traders.length === 0) {
      console.log(`\n⚠ ${period} 未获取到数据`)
      continue
    }
    
    // Sort by ROI
    traders.sort((a, b) => b.roi - a.roi)
    const top = traders.slice(0, TARGET_COUNT)
    
    console.log(`\n📋 ${period} TOP 10:`)
    top.slice(0, 10).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%, PnL $${t.pnl?.toFixed(2)}, WR ${t.winRate}%`)
    })
    
    const result = await saveTraders(top, period)
    results.push({ period, count: traders.length, saved: result.saved, topRoi: top[0]?.roi || 0 })
  }
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  
  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ 全部完成！`)
  console.log(`${'='.repeat(60)}`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
  }
  console.log(`   总耗时: ${totalTime}s`)
}

main()
