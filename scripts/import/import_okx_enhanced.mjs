/**
 * OKX 增强版数据抓取 - 目标1000+交易员
 * 
 * 包含 Futures + Spot 两个市场
 * 支持多种排序方式获取更多样化数据
 * 
 * 用法: node scripts/import/import_okx_enhanced.mjs [7D|30D|90D|ALL]
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

const SOURCES = {
  futures: 'okx_futures',
  spot: 'okx_spot'
}

const API_BASE = 'https://www.okx.com/api/v5/copytrading'
const FUTURES_API = `${API_BASE}/public-lead-traders?instType=SWAP`
const SPOT_API = `${API_BASE}/public-lead-traders?instType=SPOT`

const TARGET_COUNT = 1000
const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

const HEADERS = {
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.okx.com/copy-trading/leaderboard'
}

/**
 * 从 pnlRatios 数组计算特定窗口的 ROI 和最大回撤
 */
function computePeriodMetrics(pnlRatios, period) {
  if (!Array.isArray(pnlRatios) || pnlRatios.length < 2) {
    return { roi: null, maxDrawdown: null }
  }

  // 按时间排序 (从旧到新)
  const sorted = [...pnlRatios].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  const days = WINDOW_DAYS[period] || 90
  const relevant = sorted.slice(-days)

  if (relevant.length < 2) {
    return { roi: null, maxDrawdown: null }
  }

  // 计算周期ROI
  const firstRatio = parseFloat(relevant[0].pnlRatio)
  const lastRatio = parseFloat(relevant[relevant.length - 1].pnlRatio)
  const roi = ((1 + lastRatio) / (1 + firstRatio) - 1) * 100

  // 计算最大回撤
  const equityCurve = relevant.map(r => 1 + parseFloat(r.pnlRatio))
  let peak = equityCurve[0]
  let maxDrawdown = 0
  
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = ((peak - eq) / peak) * 100
      if (dd > maxDrawdown) maxDrawdown = dd
    }
  }

  return {
    roi: isFinite(roi) ? roi : null,
    maxDrawdown: maxDrawdown > 0 && maxDrawdown < 100 ? maxDrawdown : null
  }
}

/**
 * 获取单个市场的排行榜数据
 * 支持多种排序方式以获取更多样化的数据
 */
async function fetchMarketLeaderboard(apiUrl, marketType, period) {
  console.log(`\n📊 获取 OKX ${marketType} 排行榜 (${period})...`)
  
  const allTraders = new Map() // 使用Map避免重复
  const sortOrders = ['pnlRatio', 'winRatio', 'copyTraderNum'] // 不同排序方式
  
  for (const sortBy of sortOrders) {
    console.log(`  🔍 按 ${sortBy} 排序获取数据...`)
    
    let page = 1
    let totalPages = 1
    let emptyPages = 0
    
    while (page <= Math.min(totalPages, 100) && allTraders.size < TARGET_COUNT && emptyPages < 3) {
      try {
        const url = `${apiUrl}&page=${page}&sort=${sortBy}`
        
        const response = await withRetry(async () => {
          const res = await fetch(url, { headers: HEADERS })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res
        }, 3, 1000)
        
        const json = await response.json()
        
        if (json.code !== '0' || !json.data?.length) {
          console.log(`    ⚠ API错误: ${json.code} - ${json.msg || 'No data'}`)
          emptyPages++
          await randomDelay(1000, 2000)
          page++
          continue
        }

        const item = json.data[0]
        totalPages = Math.min(parseInt(item.totalPage) || totalPages, 50) // 限制最大页数
        const ranks = item.ranks || []

        if (page === 1) {
          console.log(`    📋 总页数: ${totalPages} (${sortBy}排序)`)
        }

        if (ranks.length === 0) {
          emptyPages++
          page++
          continue
        }

        let added = 0
        for (const t of ranks) {
          const uniqueCode = t.uniqueCode
          if (!uniqueCode || allTraders.has(uniqueCode)) continue

          // 验证数据质量
          const totalRoi = parseFloat(t.pnlRatio || 0) * 100
          if (Math.abs(totalRoi) > 10000) continue // 过滤异常数据

          const totalPnl = parseFloat(t.pnl || 0)
          const winRate = t.winRatio != null ? parseFloat(t.winRatio) * 100 : null
          const followers = parseInt(t.copyTraderNum || 0)

          // 从历史数据计算特定周期指标
          const pnlRatios = t.pnlRatios || []
          const metrics = computePeriodMetrics(pnlRatios, period)

          allTraders.set(uniqueCode, {
            traderId: uniqueCode,
            nickname: t.nickName || `Trader_${uniqueCode.slice(0, 8)}`,
            avatar: t.portLink || null,
            roi: metrics.roi !== null ? metrics.roi : totalRoi,
            pnl: totalPnl,
            winRate,
            maxDrawdown: metrics.maxDrawdown,
            followers,
            sortedBy: sortBy // 记录数据来源
          })
          added++
        }

        console.log(`    第${page}页: +${added} 条, 累计 ${allTraders.size}`)
        
        if (added === 0) emptyPages++
        else emptyPages = 0
        
        page++
        await randomDelay(300, 800) // 随机延迟防止被限流
        
      } catch (e) {
        console.log(`    ⚠ 页面 ${page} 错误: ${e.message}`)
        emptyPages++
        page++
        await randomDelay(2000, 4000)
      }
    }
    
    console.log(`  ✓ ${sortBy} 排序完成，累计 ${allTraders.size} 个交易员`)
    
    // 排序方式之间的延迟
    if (sortOrders.indexOf(sortBy) < sortOrders.length - 1) {
      await randomDelay(2000, 4000)
    }
  }

  const traders = Array.from(allTraders.values())
    .filter(t => t.roi !== null && !isNaN(t.roi))
    .sort((a, b) => b.roi - a.roi)
    .slice(0, TARGET_COUNT)

  console.log(`  ✅ ${marketType} 最终获取: ${traders.length} 个交易员`)
  return { traders, marketType }
}

/**
 * 保存交易员数据
 */
async function saveTraders(traders, source, marketType, period) {
  if (traders.length === 0) return 0

  console.log(`\n💾 保存 ${source} (${marketType}) ${traders.length} 条数据...`)
  
  const capturedAt = new Date().toISOString()
  const profileBaseUrl = marketType === 'futures' 
    ? 'https://www.okx.com/copy-trading/account/' 
    : 'https://www.okx.com/copy-trading/spot-account/'

  // 1. upsert trader_sources
  const sourcesData = traders.map(t => ({
    source,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    profile_url: `${profileBaseUrl}${t.traderId}`,
    is_active: true,
    source_kind: 'cex',
    market_type: marketType === 'futures' ? 'futures' : 'spot'
  }))

  const { error: srcErr } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  if (srcErr) {
    console.log(`  ⚠ trader_sources错误: ${srcErr.message}`)
  }

  // 2. upsert trader_snapshots  
  const snapshotsData = traders.map((t, idx) => ({
    source,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl || null,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown || null,
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
  const periods = getTargetPeriods(['30D'])
  const startTime = Date.now()

  console.log(`\n${'='.repeat(70)}`)
  console.log(`OKX 增强版数据抓取 - 目标1000+交易员`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`${'='.repeat(70)}`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(50)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`${'='.repeat(50)}`)
    
    // 只抓取 Futures 数据 (Spot API 暂时有问题)
    const marketResults = [
      await fetchMarketLeaderboard(FUTURES_API, 'futures', period)
      // await fetchMarketLeaderboard(SPOT_API, 'spot', period) // 暂时注释，API返回400
    ]
    
    // 保存各市场数据
    for (const { traders, marketType } of marketResults) {
      if (traders.length > 0) {
        const source = marketType === 'futures' ? SOURCES.futures : SOURCES.spot
        
        console.log(`\n📋 ${marketType.toUpperCase()} TOP 5:`)
        traders.slice(0, 5).forEach((t, idx) => {
          const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
          const mdd = t.maxDrawdown !== null ? `${t.maxDrawdown.toFixed(1)}%` : 'N/A'
          console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi.toFixed(2)}%, WR ${wr}, MDD ${mdd}`)
        })

        const saved = await saveTraders(traders, source, marketType, period)
        results.push({ 
          period, 
          market: marketType, 
          count: traders.length, 
          saved,
          topRoi: traders[0]?.roi || 0
        })
        
        console.log(`\n✅ ${marketType.toUpperCase()} 完成！保存了 ${saved} 条数据`)
      }
    }
    
    // 周期间延迟
    if (periods.indexOf(period) < periods.length - 1) {
      console.log(`\n⏳ 等待 5 秒后抓取下一个时间段...`)
      await sleep(5000)
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalSaved = results.reduce((sum, r) => sum + r.saved, 0)

  console.log(`\n${'='.repeat(70)}`)
  console.log(`✅ OKX 增强版抓取完成！`)
  console.log(`${'='.repeat(70)}`)
  console.log(`📊 抓取结果:`)
  for (const r of results) {
    console.log(`   ${r.period} ${r.market}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
  }
  console.log(`   总计: ${totalSaved} 条数据`)
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(70)}`)
}

main().catch(console.error)