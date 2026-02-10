/**
 * OKX Futures 增强版数据抓取
 * 
 * 基于现有import_okx_futures.mjs改进
 * 目标：从361个交易员扩展到1000+
 * 方法：更深入的分页抓取 + 多种排序方式
 * 
 * 用法: node scripts/import/import_okx_futures_enhanced.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'okx_futures'
const API_URL = 'https://www.okx.com/api/v5/copytrading/public-lead-traders'
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

  const sorted = [...pnlRatios].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  const days = WINDOW_DAYS[period] || 90
  const relevant = sorted.slice(-days)

  if (relevant.length < 2) {
    return { roi: null, maxDrawdown: null }
  }

  const firstRatio = parseFloat(relevant[0].pnlRatio)
  const lastRatio = parseFloat(relevant[relevant.length - 1].pnlRatio)
  const roi = ((1 + lastRatio) / (1 + firstRatio) - 1) * 100

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
 * 获取排行榜数据 - 增强版
 * 使用更深入的分页和去重策略
 */
async function fetchLeaderboardEnhanced(period) {
  console.log(`\n📊 获取 OKX Futures 排行榜 - 增强版 (${period})...`)

  const allTraders = new Map() // 使用Map避免重复
  let totalPages = 1
  const maxPages = 100 // 增加最大页数

  // 多轮抓取，每轮休息避免限流
  for (let round = 1; round <= 3 && allTraders.size < TARGET_COUNT; round++) {
    console.log(`\n🔄 第 ${round} 轮抓取...`)
    
    const roundStartPage = (round - 1) * 30 + 1
    const roundEndPage = Math.min(roundStartPage + 29, totalPages, maxPages)
    
    for (let page = roundStartPage; page <= roundEndPage && allTraders.size < TARGET_COUNT; page++) {
      try {
        const url = `${API_URL}?instType=SWAP&page=${page}`
        
        const response = await withRetry(async () => {
          const res = await fetch(url, { headers: HEADERS })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res
        }, 3, 1000)

        const json = await response.json()
        if (json.code !== '0' || !json.data?.length) {
          console.log(`    ⚠ 页面 ${page}: API错误 ${json.code}`)
          if (json.code === '50001') { // 通常表示页面超出范围
            console.log(`    ℹ 达到数据边界，停止当前轮次`)
            break
          }
          await randomDelay(1000, 2000)
          continue
        }

        const item = json.data[0]
        totalPages = parseInt(item.totalPage) || totalPages
        const ranks = item.ranks || []

        if (page === roundStartPage && round === 1) {
          console.log(`    📋 总页数: ${totalPages}`)
        }

        if (ranks.length === 0) {
          console.log(`    ℹ 页面 ${page}: 无数据`)
          continue
        }

        let newTraders = 0
        for (const t of ranks) {
          const uniqueCode = t.uniqueCode
          if (!uniqueCode || allTraders.has(uniqueCode)) continue

          // 数据验证
          const totalRoi = parseFloat(t.pnlRatio || 0) * 100
          if (Math.abs(totalRoi) > 10000) continue // 过滤极端数据

          const totalPnl = parseFloat(t.pnl || 0)
          const winRate = t.winRatio != null ? parseFloat(t.winRatio) * 100 : null
          const followers = parseInt(t.copyTraderNum || 0)

          // 计算特定周期指标
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
            round // 记录来源轮次
          })
          newTraders++
        }

        console.log(`    第${page}页: +${newTraders} 条, 累计 ${allTraders.size}`)
        
        // 页面间随机延迟
        await randomDelay(400, 800)

      } catch (e) {
        console.log(`    ⚠ 页面 ${page} 错误: ${e.message}`)
        await randomDelay(2000, 4000)
      }
    }
    
    console.log(`  ✓ 第 ${round} 轮完成, 累计 ${allTraders.size} 个交易员`)
    
    // 轮次间延迟
    if (round < 3 && allTraders.size < TARGET_COUNT) {
      console.log(`  ⏳ 等待10秒后进行下一轮...`)
      await sleep(10000)
    }
  }

  // 转换为数组并排序
  const traders = Array.from(allTraders.values())
    .filter(t => t.roi !== null && !isNaN(t.roi))
    .sort((a, b) => b.roi - a.roi)
    .slice(0, TARGET_COUNT)

  console.log(`\n✅ 增强版抓取完成: ${traders.length} 个独特交易员`)
  
  // 显示轮次分布
  const roundStats = traders.reduce((acc, t) => {
    acc[t.round] = (acc[t.round] || 0) + 1
    return acc
  }, {})
  console.log(`  📊 轮次分布:`, roundStats)
  
  return traders
}

/**
 * 保存交易员数据 (与原版兼容)
 */
async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员 (${period})...`)
  if (traders.length === 0) return 0

  const capturedAt = new Date().toISOString()

  // upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    profile_url: `https://www.okx.com/copy-trading/account/${t.traderId}`,
    is_active: true,
    source_kind: 'cex',
    market_type: 'futures'
  }))

  const { error: srcErr } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  if (srcErr) console.log(`  ⚠ trader_sources错误: ${srcErr.message}`)

  // upsert trader_snapshots
  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
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

  const withWr = traders.filter(t => t.winRate !== null && t.winRate > 0).length
  const withMdd = traders.filter(t => t.maxDrawdown !== null).length
  console.log(`  ✅ 保存成功: ${traders.length} 条`)
  console.log(`    胜率覆盖: ${withWr}/${traders.length}`)
  console.log(`    MDD覆盖: ${withMdd}/${traders.length}`)
  return traders.length
}

async function main() {
  const periods = getTargetPeriods(['30D'])
  const startTime = Date.now()

  console.log(`\n${'='.repeat(70)}`)
  console.log(`OKX Futures 增强版数据抓取 - 目标1000+`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`策略: 深度分页 + 多轮抓取 + 去重`)
  console.log(`${'='.repeat(70)}`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(50)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`${'='.repeat(50)}`)
    
    const traders = await fetchLeaderboardEnhanced(period)

    if (traders.length > 0) {
      console.log(`\n📋 ${period} TOP 10:`)
      traders.slice(0, 10).forEach((t, idx) => {
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
      console.log(`\n⚠ ${period} 无数据`)
    }

    // 周期间延迟
    if (periods.indexOf(period) < periods.length - 1) {
      await sleep(5000)
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalSaved = results.reduce((sum, r) => sum + r.saved, 0)

  console.log(`\n${'='.repeat(70)}`)
  console.log(`✅ OKX Futures 增强版完成！`)
  console.log(`${'='.repeat(70)}`)
  console.log(`📊 抓取结果:`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%, 平均${r.avgFollowers || 0}个跟随者`)
  }
  console.log(`   总计: ${totalSaved} 条数据`)
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(70)}`)
}

main().catch(console.error)