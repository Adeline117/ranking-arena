/**
 * Crypto.com Copy Trading 排行榜数据抓取
 * 
 * API: https://crypto.com/api/copy-trading/lead-traders
 * 支持多种排序和时间段
 * 
 * 用法: node scripts/import/import_crypto_com.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'crypto_com'
const API_BASE = 'https://crypto.com/api'
const LEADERBOARD_API = `${API_BASE}/copy-trading/lead-traders`
const PROFILE_BASE = 'https://crypto.com/exchange/copy-trading/trader'

const TARGET_COUNT = 800
const REQUEST_DELAY = 800 // 较保守的请求频率

const HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://crypto.com/exchange/copy-trading',
  'Origin': 'https://crypto.com'
}

// 排序方式和时间段映射
const SORT_OPTIONS = [
  'roi_desc',     // 按收益率降序
  'pnl_desc',     // 按盈亏降序
  'followers_desc', // 按跟随者数量降序
  'winrate_desc'  // 按胜率降序
]

const PERIOD_MAP = {
  '7D': '7d',
  '30D': '30d', 
  '90D': '90d'
}

/**
 * 构建API请求参数
 */
function buildApiParams(page = 1, limit = 50, sortBy = 'roi_desc', period = '30d') {
  return {
    page,
    limit,
    sort: sortBy,
    period,
    asset: 'ALL',
    type: 'PERPETUAL' // 主要关注永续合约
  }
}

/**
 * 获取排行榜数据 - 支持多种排序方式
 */
async function fetchLeaderboardData(period) {
  console.log(`\n📊 获取 Crypto.com 排行榜 (${period})...`)
  
  const allTraders = new Map() // 避免重复
  const apiPeriod = PERIOD_MAP[period] || '30d'
  
  for (const sortBy of SORT_OPTIONS) {
    console.log(`  🔍 按 ${sortBy} 排序获取数据...`)
    
    let page = 1
    const maxPages = 20 // 限制最大页数
    let consecutiveEmptyPages = 0
    
    while (page <= maxPages && allTraders.size < TARGET_COUNT && consecutiveEmptyPages < 3) {
      try {
        const params = buildApiParams(page, 50, sortBy, apiPeriod)
        const queryString = new URLSearchParams(params).toString()
        const url = `${LEADERBOARD_API}?${queryString}`
        
        const response = await withRetry(async () => {
          const res = await fetch(url, { headers: HEADERS })
          if (!res.ok) {
            if (res.status === 429) {
              console.log('    ⏳ 触发限流，等待5秒...')
              await sleep(5000)
            }
            throw new Error(`HTTP ${res.status}`)
          }
          return res
        }, 3, 2000)
        
        const data = await response.json()
        
        if (!data.result || !Array.isArray(data.result.data)) {
          console.log(`    ⚠ API响应格式错误: ${JSON.stringify(data).slice(0, 200)}`)
          consecutiveEmptyPages++
          page++
          await randomDelay(REQUEST_DELAY, REQUEST_DELAY * 2)
          continue
        }
        
        const traders = data.result.data
        
        if (traders.length === 0) {
          console.log(`    ℹ 第 ${page} 页无数据`)
          consecutiveEmptyPages++
          page++
          await randomDelay(REQUEST_DELAY, REQUEST_DELAY * 2)
          continue
        }
        
        let added = 0
        for (const trader of traders) {
          const traderId = trader.userId || trader.id
          if (!traderId || allTraders.has(traderId)) continue
          
          // 数据验证和清洗
          const roi = parseFloat(trader.roi || trader.returnRate || 0)
          if (Math.abs(roi) > 10000) continue // 过滤异常数据
          
          const pnl = parseFloat(trader.pnl || trader.realizedPnl || 0)
          let winRate = parseFloat(trader.winRate || trader.winRatio || 0)
          
          // 标准化胜率
          if (winRate > 1) winRate = winRate / 100
          
          const followers = parseInt(trader.followers || trader.copierCount || 0)
          const maxDrawdown = parseFloat(trader.maxDrawdown || trader.mdd || 0)
          
          allTraders.set(traderId, {
            traderId,
            nickname: trader.nickname || trader.username || `Trader_${traderId}`,
            avatar: trader.avatar || trader.avatarUrl || null,
            roi,
            pnl,
            winRate: winRate * 100, // 转换为百分比
            maxDrawdown: maxDrawdown > 0 ? maxDrawdown : null,
            followers,
            totalTrades: parseInt(trader.totalTrades || 0),
            aum: parseFloat(trader.aum || trader.totalAssets || 0),
            sortedBy: sortBy
          })
          added++
        }
        
        console.log(`    第${page}页: +${added} 条, 累计 ${allTraders.size}`)
        
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
    
    console.log(`  ✓ ${sortBy} 排序完成，累计 ${allTraders.size} 个交易员`)
    
    // 排序方式之间的延迟
    if (SORT_OPTIONS.indexOf(sortBy) < SORT_OPTIONS.length - 1) {
      await randomDelay(3000, 5000)
    }
  }
  
  // 转换为数组并排序
  const traders = Array.from(allTraders.values())
    .filter(t => t.roi !== null && !isNaN(t.roi))
    .sort((a, b) => b.roi - a.roi)
    .slice(0, TARGET_COUNT)
  
  console.log(`  ✅ 最终获取: ${traders.length} 个交易员`)
  return traders
}

/**
 * 尝试获取更详细的交易员信息
 */
async function enrichTraderData(traders) {
  console.log(`\n🔍 尝试获取交易员详细信息...`)
  
  let enriched = 0
  const limit = Math.min(100, traders.length) // 只处理前100个
  
  for (let i = 0; i < limit; i++) {
    const trader = traders[i]
    
    try {
      const detailUrl = `${API_BASE}/copy-trading/trader/${trader.traderId}/detail`
      
      const response = await fetch(detailUrl, { headers: HEADERS })
      if (!response.ok) continue
      
      const data = await response.json()
      if (data.result && data.result.trader) {
        const detail = data.result.trader
        
        // 更新交易员信息
        if (detail.performance) {
          trader.roi = parseFloat(detail.performance.roi || trader.roi)
          trader.pnl = parseFloat(detail.performance.pnl || trader.pnl)
          trader.maxDrawdown = parseFloat(detail.performance.maxDrawdown || trader.maxDrawdown)
          trader.winRate = parseFloat(detail.performance.winRate || trader.winRate)
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

  console.log(`\n💾 保存 ${traders.length} 条 Crypto.com 数据...`)
  
  const capturedAt = new Date().toISOString()

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
    market_type: 'futures' // Crypto.com主要是永续合约
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
  console.log(`Crypto.com Copy Trading 数据抓取`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`目标数量: ${TARGET_COUNT} 交易员/周期`)
  console.log(`${'='.repeat(60)}`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(40)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`${'='.repeat(40)}`)
    
    const traders = await fetchLeaderboardData(period)
    
    if (traders.length > 0) {
      // 尝试丰富数据
      await enrichTraderData(traders)
      
      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, idx) => {
        const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
        const mdd = t.maxDrawdown !== null ? `${t.maxDrawdown.toFixed(1)}%` : 'N/A'
        const followers = t.followers || 0
        console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi.toFixed(2)}%, WR ${wr}, MDD ${mdd}, ${followers} followers`)
      })

      const saved = await saveTraders(traders, period)
      results.push({ 
        period, 
        count: traders.length, 
        saved,
        topRoi: traders[0]?.roi || 0,
        avgFollowers: Math.round(traders.reduce((sum, t) => sum + (t.followers || 0), 0) / traders.length)
      })
      
      console.log(`\n✅ ${period} 完成！保存了 ${saved} 条数据`)
    } else {
      console.log(`\n⚠ ${period} 未获取到数据`)
    }
    
    // 周期间延迟
    if (periods.indexOf(period) < periods.length - 1) {
      console.log(`\n⏳ 等待 5 秒后抓取下一个时间段...`)
      await sleep(5000)
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalSaved = results.reduce((sum, r) => sum + r.saved, 0)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Crypto.com 抓取完成！`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📊 抓取结果:`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%, 平均${r.avgFollowers || 0}个跟随者`)
  }
  console.log(`   总计: ${totalSaved} 条数据`)
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)