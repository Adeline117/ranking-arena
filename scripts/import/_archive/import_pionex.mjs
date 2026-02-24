/**
 * Pionex Copy Trading 排行榜数据抓取
 * 
 * API: https://api.pionex.com/api/copy-trading/lead-traders
 * 支持多种排序方式和市场类型
 * 
 * 用法: node scripts/import/import_pionex.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'pionex'
const API_BASE = 'https://api.pionex.com/api'
const LEADERBOARD_API = `${API_BASE}/copy-trading/lead-traders`
const PROFILE_BASE = 'https://www.pionex.com/copy-trading'

const TARGET_COUNT = 600
const REQUEST_DELAY = 1000 // 1秒延迟，较保守

const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.pionex.com/copy-trading',
  'Origin': 'https://www.pionex.com'
}

// 支持的排序方式
const SORT_OPTIONS = [
  'pnl',          // 按盈亏排序
  'roi',          // 按收益率排序  
  'follower_count', // 按跟随者数量排序
  'win_rate'      // 按胜率排序
]

// 市场类型
const MARKET_TYPES = [
  'futures',      // 合约交易
  'spot'          // 现货交易
]

// 时间段映射
const PERIOD_MAP = {
  '7D': '7d',
  '30D': '30d', 
  '90D': '90d'
}

/**
 * 获取单个市场的排行榜数据
 */
async function fetchMarketLeaderboard(marketType, period, sortBy) {
  console.log(`  🔍 获取 ${marketType} 市场数据 (排序: ${sortBy})...`)
  
  const traders = []
  const apiPeriod = PERIOD_MAP[period] || '30d'
  const pageSize = 50
  let page = 1
  const maxPages = 20
  let consecutiveEmptyPages = 0
  
  while (page <= maxPages && traders.length < TARGET_COUNT / 2 && consecutiveEmptyPages < 3) {
    try {
      const requestBody = {
        market: marketType,
        period: apiPeriod,
        sort: sortBy,
        order: 'desc',
        page: page,
        limit: pageSize
      }
      
      const response = await withRetry(async () => {
        const res = await fetch(LEADERBOARD_API, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(requestBody)
        })
        
        if (!res.ok) {
          if (res.status === 429) {
            console.log('    ⏳ 触发限流，等待10秒...')
            await sleep(10000)
          }
          throw new Error(`HTTP ${res.status}`)
        }
        return res
      }, 3, 2000)
      
      const data = await response.json()
      
      if (!data.success || !data.data || !Array.isArray(data.data.traders)) {
        console.log(`    ⚠ API响应格式错误: ${JSON.stringify(data).slice(0, 200)}`)
        consecutiveEmptyPages++
        page++
        await randomDelay(REQUEST_DELAY, REQUEST_DELAY * 2)
        continue
      }
      
      const traderList = data.data.traders
      
      if (traderList.length === 0) {
        console.log(`    ℹ 第 ${page} 页无数据`)
        consecutiveEmptyPages++
        page++
        await randomDelay(REQUEST_DELAY, REQUEST_DELAY * 2)
        continue
      }
      
      let added = 0
      for (const trader of traderList) {
        const traderId = trader.uid || trader.userId || trader.id
        if (!traderId) continue
        
        // 数据验证
        const roi = parseFloat(trader.roi || trader.returnRate || 0)
        if (Math.abs(roi) > 5000) continue // 过滤异常数据
        
        const pnl = parseFloat(trader.pnl || trader.totalPnl || 0)
        let winRate = parseFloat(trader.winRate || trader.winRatio || 0)
        
        // 标准化胜率
        if (winRate > 1) winRate = winRate / 100
        
        const followers = parseInt(trader.followers || trader.copierCount || 0)
        const maxDrawdown = parseFloat(trader.maxDrawdown || trader.mdd || 0)
        const totalTrades = parseInt(trader.totalTrades || trader.orderCount || 0)
        
        traders.push({
          traderId,
          nickname: trader.nickname || trader.username || trader.displayName || `Trader_${traderId}`,
          avatar: trader.avatar || trader.avatarUrl || trader.headImg || null,
          roi,
          pnl,
          winRate: winRate * 100, // 转换为百分比
          maxDrawdown: maxDrawdown > 0 ? maxDrawdown : null,
          followers,
          totalTrades,
          aum: parseFloat(trader.aum || trader.followedAmount || 0),
          marketType,
          sortedBy: sortBy
        })
        added++
      }
      
      console.log(`    第${page}页: +${added} 条, 累计 ${traders.length}`)
      
      if (added === 0) {
        consecutiveEmptyPages++
      } else {
        consecutiveEmptyPages = 0
      }
      
      page++
      await randomDelay(REQUEST_DELAY, REQUEST_DELAY * 2)
      
    } catch (e) {
      console.log(`    ⚠ 页面 ${page} 错误: ${e.message}`)
      consecutiveEmptyPages++
      page++
      await randomDelay(REQUEST_DELAY * 2, REQUEST_DELAY * 4)
    }
  }
  
  return traders
}

/**
 * 获取所有市场和排序方式的数据
 */
async function fetchAllLeaderboards(period) {
  console.log(`\n📊 获取 Pionex 排行榜数据 (${period})...`)
  
  const allTraders = new Map() // 使用Map避免重复
  
  for (const marketType of MARKET_TYPES) {
    console.log(`\n🏪 处理 ${marketType.toUpperCase()} 市场...`)
    
    for (const sortBy of SORT_OPTIONS) {
      const traders = await fetchMarketLeaderboard(marketType, period, sortBy)
      
      // 添加到总集合，避免重复
      let newTraders = 0
      for (const trader of traders) {
        const key = `${trader.traderId}_${marketType}`
        if (!allTraders.has(key)) {
          allTraders.set(key, trader)
          newTraders++
        }
      }
      
      console.log(`  ✓ ${sortBy} 排序: ${traders.length} 条，新增 ${newTraders} 条`)
      
      // 排序方式之间的延迟
      await randomDelay(2000, 4000)
    }
    
    console.log(`  ✅ ${marketType.toUpperCase()} 市场完成`)
    
    // 市场之间的延迟
    if (MARKET_TYPES.indexOf(marketType) < MARKET_TYPES.length - 1) {
      await sleep(5000)
    }
  }
  
  // 转换为数组并按ROI排序
  const finalTraders = Array.from(allTraders.values())
    .filter(t => t.roi !== null && !isNaN(t.roi))
    .sort((a, b) => b.roi - a.roi)
    .slice(0, TARGET_COUNT)
  
  console.log(`\n✅ 总计获取: ${finalTraders.length} 个独特交易员`)
  return finalTraders
}

/**
 * 尝试获取交易员的详细信息
 */
async function enrichTraderDetails(traders) {
  console.log(`\n🔍 获取交易员详细信息...`)
  
  let enriched = 0
  const limit = Math.min(50, traders.length) // 只处理前50个
  
  for (let i = 0; i < limit; i++) {
    const trader = traders[i]
    
    try {
      const detailUrl = `${API_BASE}/copy-trading/trader/${trader.traderId}/profile`
      
      const response = await fetch(detailUrl, { headers: HEADERS })
      if (!response.ok) continue
      
      const data = await response.json()
      if (data.success && data.data) {
        const detail = data.data
        
        // 更新交易员信息
        if (detail.statistics) {
          trader.roi = parseFloat(detail.statistics.roi || trader.roi)
          trader.pnl = parseFloat(detail.statistics.totalPnl || trader.pnl)
          trader.maxDrawdown = parseFloat(detail.statistics.maxDrawdown || trader.maxDrawdown)
          trader.winRate = parseFloat(detail.statistics.winRate || trader.winRate)
          trader.totalTrades = parseInt(detail.statistics.totalTrades || trader.totalTrades)
        }
        
        if (detail.profile) {
          trader.nickname = detail.profile.nickname || trader.nickname
          trader.avatar = detail.profile.avatar || trader.avatar
        }
        
        enriched++
      }
      
      await randomDelay(REQUEST_DELAY, REQUEST_DELAY * 2)
      
    } catch (e) {
      // 静默跳过错误
    }
  }
  
  console.log(`  ✓ 成功丰富 ${enriched}/${limit} 个交易员数据`)
  return traders
}

/**
 * 保存交易员数据
 */
async function saveTraders(traders, period) {
  if (traders.length === 0) return 0

  console.log(`\n💾 保存 ${traders.length} 条 Pionex 数据...`)
  
  const capturedAt = new Date().toISOString()

  // 1. upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    profile_url: `${PROFILE_BASE}/trader/${t.traderId}`,
    is_active: true,
    source_kind: 'cex',
    market_type: t.marketType || 'futures'
  }))

  const { error: srcErr } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  if (srcErr) {
    console.log(`  ⚠ trader_sources错误: ${srcErr.message}`)
  }

  // 2. upsert trader_snapshots  
  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi || 0,
    pnl: t.pnl || null,
    win_rate: t.winRate || null,
    max_drawdown: t.maxDrawdown || null,
    trade_count: t.totalTrades || null,
    followers: t.followers || null,
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore,
    captured_at: capturedAt,
  }))

  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
    onConflict: 'source,source_trader_id,season_id'
  })

  if (error) {
    console.log(`  ⚠ 批量upsert失败: ${error.message}`)
    // 逐条重试
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, {
        onConflict: 'source,source_trader_id,season_id'
      })
      if (!e) saved++
    }
    console.log(`  ✓ 逐条保存: ${saved}/${snapshotsData.length}`)
    return saved
  }

  console.log(`  ✅ 保存成功: ${traders.length} 条`)
  return traders.length
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  const startTime = Date.now()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Pionex Copy Trading 数据抓取`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`目标数量: ${TARGET_COUNT} 交易员/周期`)
  console.log(`${'='.repeat(60)}`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(40)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`${'='.repeat(40)}`)
    
    const traders = await fetchAllLeaderboards(period)
    
    if (traders.length > 0) {
      // 尝试丰富数据
      await enrichTraderDetails(traders)
      
      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, idx) => {
        const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
        const mdd = t.maxDrawdown !== null ? `${t.maxDrawdown.toFixed(1)}%` : 'N/A'
        const followers = t.followers || 0
        const market = t.marketType || 'futures'
        console.log(`  ${idx + 1}. ${t.nickname} [${market}]: ROI ${t.roi.toFixed(2)}%, WR ${wr}, MDD ${mdd}, ${followers} followers`)
      })

      const saved = await saveTraders(traders, period)
      
      // 统计市场分布
      const marketStats = traders.reduce((acc, t) => {
        acc[t.marketType || 'futures'] = (acc[t.marketType || 'futures'] || 0) + 1
        return acc
      }, {})
      
      results.push({ 
        period, 
        count: traders.length, 
        saved,
        topRoi: traders[0]?.roi || 0,
        marketStats
      })
      
      console.log(`\n✅ ${period} 完成！保存了 ${saved} 条数据`)
      console.log(`   市场分布:`, marketStats)
    } else {
      console.log(`\n⚠ ${period} 未获取到数据`)
    }
    
    // 周期间延迟
    if (periods.indexOf(period) < periods.length - 1) {
      console.log(`\n⏳ 等待 10 秒后抓取下一个时间段...`)
      await sleep(10000)
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalSaved = results.reduce((sum, r) => sum + r.saved, 0)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Pionex 抓取完成！`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📊 抓取结果:`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
  }
  console.log(`   总计: ${totalSaved} 条数据`)
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)