/**
 * Bitfinex Paper Trading Competition 排行榜数据抓取
 * 
 * API: https://api-pub.bitfinex.com/v2/competitions/leaderboards
 * 数据源: Bitfinex官方排行榜
 * 
 * 用法: node scripts/import/import_bitfinex.mjs [7D|30D|90D|ALL]
 */

import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
  randomDelay,
  withRetry,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'bitfinex'
const API_BASE = 'https://api-pub.bitfinex.com/v2'
const LEADERBOARD_API = `${API_BASE}/competitions/leaderboards`
const PROFILE_BASE = 'https://www.bitfinex.com/leaderboard'

const TARGET_COUNT = 500
const REQUEST_DELAY = 500 // 500ms between requests

const HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bitfinex.com/leaderboard'
}

// Bitfinex 竞赛类型映射
const COMPETITION_TYPES = {
  'trading_competition': 'spot',      // 现货交易竞赛
  'derivatives_competition': 'futures' // 衍生品交易竞赛
}

/**
 * 获取当前活跃竞赛列表
 */
async function fetchCompetitions() {
  console.log(`\n🔍 获取 Bitfinex 活跃竞赛列表...`)
  
  try {
    const response = await withRetry(async () => {
      const res = await fetch(`${API_BASE}/competitions`, { headers: HEADERS })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    }, 3, 1000)
    
    const competitions = await response.json()
    
    if (!Array.isArray(competitions)) {
      console.log('  ⚠ 无效的竞赛数据格式')
      return []
    }
    
    const active = competitions.filter(comp => 
      comp.status === 'active' || comp.status === 'running'
    )
    
    console.log(`  ✓ 找到 ${active.length} 个活跃竞赛`)
    return active
    
  } catch (e) {
    console.log(`  ⚠ 获取竞赛列表失败: ${e.message}`)
    
    // 如果API失败，使用预定义的竞赛ID
    return [
      { id: 'trading_competition_2026', type: 'trading', market_type: 'spot' },
      { id: 'derivatives_2026', type: 'derivatives', market_type: 'futures' }
    ]
  }
}

/**
 * 获取单个竞赛的排行榜数据
 */
async function fetchCompetitionLeaderboard(competition, period) {
  const { id: compId, type: compType } = competition
  const marketType = COMPETITION_TYPES[compType] || 'spot'
  
  console.log(`\n📊 获取竞赛排行榜: ${compId} (${marketType})...`)
  
  const traders = []
  const limit = 100
  let offset = 0
  let hasMore = true
  
  while (hasMore && traders.length < TARGET_COUNT) {
    try {
      const url = `${LEADERBOARD_API}/${compId}?limit=${limit}&offset=${offset}&period=${period.toLowerCase()}`
      
      const response = await withRetry(async () => {
        const res = await fetch(url, { headers: HEADERS })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res
      }, 3, 1000)
      
      const data = await response.json()
      
      if (!Array.isArray(data)) {
        console.log(`  ⚠ 竞赛 ${compId} 数据格式错误`)
        break
      }
      
      if (data.length === 0) {
        console.log(`  ℹ 竞赛 ${compId} 无更多数据`)
        break
      }
      
      let validCount = 0
      for (const entry of data) {
        // Bitfinex API 返回格式: [username, pnl, roi, ...]
        const [username, pnl, roi, rank, volume, trades, winRate] = entry
        
        if (!username || username === 'null') continue
        
        // 数据验证
        const roiValue = parseFloat(roi || 0)
        if (Math.abs(roiValue) > 5000) continue // 过滤异常ROI
        
        const pnlValue = parseFloat(pnl || 0)
        const winRateValue = parseFloat(winRate || 0)
        const tradesValue = parseInt(trades || 0)
        
        traders.push({
          traderId: username,
          nickname: username,
          avatar: null, // Bitfinex 不提供头像
          roi: roiValue,
          pnl: pnlValue,
          winRate: winRateValue <= 1 ? winRateValue * 100 : winRateValue,
          maxDrawdown: null, // Bitfinex 不提供回撤数据
          tradeCount: tradesValue,
          volume: parseFloat(volume || 0),
          rank: parseInt(rank || (offset + validCount + 1)),
          competitionId: compId,
          marketType
        })
        
        validCount++
      }
      
      console.log(`  页面 ${Math.floor(offset/limit) + 1}: +${validCount} 条, 累计 ${traders.length}`)
      
      offset += limit
      hasMore = data.length === limit
      
      await randomDelay(REQUEST_DELAY, REQUEST_DELAY * 2)
      
    } catch (e) {
      console.log(`  ⚠ 获取 ${compId} 数据失败: ${e.message}`)
      break
    }
  }
  
  // 按ROI排序
  traders.sort((a, b) => b.roi - a.roi)
  
  console.log(`  ✓ 竞赛 ${compId} 获取: ${traders.length} 个交易员`)
  return { traders, marketType, competitionId: compId }
}

/**
 * 获取所有竞赛的排行榜数据
 */
async function fetchAllLeaderboards(period) {
  console.log(`\n📋 开始获取 Bitfinex 排行榜数据 (${period})...`)
  
  const competitions = await fetchCompetitions()
  if (competitions.length === 0) {
    console.log('  ⚠ 没有找到活跃竞赛')
    return []
  }
  
  const allResults = []
  
  for (const competition of competitions) {
    const result = await fetchCompetitionLeaderboard(competition, period)
    if (result.traders.length > 0) {
      allResults.push(result)
    }
    
    // 竞赛之间的延迟
    await sleep(2000)
  }
  
  return allResults
}

/**
 * 保存交易员数据
 */
async function saveTraders(tradersData, period) {
  if (!tradersData || tradersData.length === 0) return 0
  
  console.log(`\n💾 保存 Bitfinex 数据...`)
  
  const capturedAt = new Date().toISOString()
  let totalSaved = 0
  
  for (const { traders, marketType, competitionId } of tradersData) {
    if (traders.length === 0) continue
    
    console.log(`  💾 保存 ${competitionId} (${marketType}): ${traders.length} 条...`)
    
    // 1. upsert trader_sources
    const sourcesData = traders.map(t => ({
      source: SOURCE,
      source_type: 'leaderboard',
      source_trader_id: t.traderId,
      handle: t.nickname,
      avatar_url: t.avatar || null,
      profile_url: `${PROFILE_BASE}/${t.traderId}`,
      is_active: true,
      source_kind: 'cex',
      market_type: marketType
    }))

    const { error: srcErr } = await supabase
      .from('trader_sources')
      .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
    
    if (srcErr) {
      console.log(`    ⚠ trader_sources错误: ${srcErr.message}`)
    }

    // 2. upsert trader_snapshots  
    const snapshotsData = traders.map((t, idx) => ({
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: t.rank || (idx + 1),
      roi: t.roi || 0,
      pnl: t.pnl || null,
      win_rate: t.winRate || null,
      max_drawdown: t.maxDrawdown || null,
      trade_count: t.tradeCount || null,
      followers: null, // Bitfinex 不提供跟随者数据
      arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore,
      captured_at: capturedAt,
    }))

    const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
      onConflict: 'source,source_trader_id,season_id'
    })

    if (error) {
      console.log(`    ⚠ 批量upsert失败: ${error.message}`)
      // 逐条重试
      let saved = 0
      for (const s of snapshotsData) {
        const { error: e } = await supabase.from('trader_snapshots').upsert(s, {
          onConflict: 'source,source_trader_id,season_id'
        })
        if (!e) saved++
      }
      console.log(`    ✓ 逐条保存: ${saved}/${snapshotsData.length}`)
      totalSaved += saved
    } else {
      console.log(`    ✅ 保存成功: ${traders.length} 条`)
      totalSaved += traders.length
    }
  }
  
  return totalSaved
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  const startTime = Date.now()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Bitfinex 排行榜数据抓取`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`${'='.repeat(60)}`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(40)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`${'='.repeat(40)}`)
    
    const tradersData = await fetchAllLeaderboards(period)
    
    if (tradersData.length > 0) {
      // 显示TOP 5
      for (const { traders, marketType } of tradersData) {
        if (traders.length > 0) {
          console.log(`\n📋 ${marketType.toUpperCase()} TOP 5:`)
          traders.slice(0, 5).forEach((t, idx) => {
            const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
            console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi.toFixed(2)}%, WR ${wr}, PnL $${t.pnl?.toFixed(2) || 'N/A'}`)
          })
        }
      }

      const saved = await saveTraders(tradersData, period)
      const totalCount = tradersData.reduce((sum, data) => sum + data.traders.length, 0)
      
      results.push({ 
        period, 
        count: totalCount, 
        saved,
        competitions: tradersData.length
      })
      
      console.log(`\n✅ ${period} 完成！保存了 ${saved} 条数据`)
    } else {
      console.log(`\n⚠ ${period} 未获取到数据`)
    }
    
    // 周期间延迟
    if (periods.indexOf(period) < periods.length - 1) {
      console.log(`\n⏳ 等待 3 秒后抓取下一个时间段...`)
      await sleep(3000)
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalSaved = results.reduce((sum, r) => sum + r.saved, 0)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Bitfinex 抓取完成！`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📊 抓取结果:`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条 (${r.competitions} 个竞赛)`)
  }
  console.log(`   总计: ${totalSaved} 条数据`)
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)