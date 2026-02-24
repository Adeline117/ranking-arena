/**
 * Binance Futures Copy Trading - 纯 API 版本（超快）
 * 
 * 直接调用内部 API，不使用浏览器
 * 速度提升：比 Playwright 版本快 10-20 倍
 * 
 * 用法: node scripts/import_binance_futures_api.mjs [7D|30D|90D] [--concurrency=10]
 */

import pLimit from 'p-limit'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
  getConcurrency,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'binance_futures'
const TARGET_COUNT = 2000
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL

// Proxy-aware fetch - tries direct first, then CF Worker proxy
async function proxyFetch(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) })
    if (res.ok || !PROXY_URL) return res
    if (res.status === 451 || res.status === 403) {
      console.log('  🔄 直连被封，尝试代理...')
      return await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
        ...options, signal: AbortSignal.timeout(15000)
      })
    }
    return res
  } catch (e) {
    if (PROXY_URL) {
      return await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
        ...options, signal: AbortSignal.timeout(15000)
      })
    }
    throw e
  }
}
const PER_PAGE = 20

// Binance 内部 API
const API_BASE = 'https://www.binance.com'
const LIST_API = `${API_BASE}/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list`
const DETAIL_API = `${API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance`

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Origin': 'https://www.binance.com',
  'Referer': 'https://www.binance.com/zh-CN/copy-trading',
}

/**
 * 获取排行榜数据
 */
async function fetchLeaderboard(period) {
  console.log(`\n📋 获取 ${period} 排行榜...`)
  
  const traders = new Map()
  let pageNum = 1
  
  while (traders.size < TARGET_COUNT && pageNum <= 10) {
    try {
      const response = await proxyFetch(LIST_API, {
        method: 'POST',
        headers: DEFAULT_HEADERS,
        body: JSON.stringify({
          pageNumber: pageNum,
          pageSize: PER_PAGE,
          timeRange: period,
          dataType: 'ROI',
          order: 'DESC',
          favoriteOnly: false,
        }),
      })
      
      if (!response.ok) {
        console.log(`  ⚠ API 返回 ${response.status}`)
        if (response.status === 429) {
          console.log('  限流，等待 3 秒...')
          await sleep(3000)
          continue
        }
        break
      }
      
      const data = await response.json()
      
      if (data.code !== '000000' || !data.data?.list) {
        console.log(`  ⚠ API 响应异常: ${data.code}`)
        break
      }
      
      const list = data.data.list
      if (list.length === 0) {
        console.log(`  第 ${pageNum} 页无数据`)
        break
      }
      
      for (const item of list) {
        const traderId = String(item.leadPortfolioId || item.portfolioId || item.encryptedUid || '')
        if (!traderId || traders.has(traderId)) continue
        
        let roi = parseFloat(item.roi ?? 0)
        // Skip anomalous data (>5000% ROI is unrealistic)
        if (Math.abs(roi) > 5000) continue
        
        let winRate = parseFloat(item.winRate ?? 0)
        if (winRate > 1) winRate = winRate / 100
        
        traders.set(traderId, {
          traderId,
          nickname: item.nickName || item.nickname || null,
          avatar: item.userPhoto || null,
          roi,
          pnl: parseFloat(item.pnl ?? 0),
          winRate,
          maxDrawdown: parseFloat(item.mdd ?? 0),
          followers: parseInt(item.copierCount ?? 0),
          aum: parseFloat(item.aum ?? 0),
        })
      }
      
      console.log(`  第 ${pageNum} 页: +${list.length} 条, 累计 ${traders.size}`)
      pageNum++
      
      // 短暂延迟避免限流
      await sleep(200)
      
    } catch (e) {
      console.log(`  ⚠ 请求失败: ${e.message}`)
      await sleep(1000)
    }
  }
  
  console.log(`  ✓ 共获取 ${traders.size} 个交易员`)
  return Array.from(traders.values())
}

/**
 * 获取单个交易员的详细数据
 */
async function fetchTraderDetail(traderId, period) {
  try {
    const url = `${DETAIL_API}?portfolioId=${traderId}&timeRange=${period}`
    const response = await fetch(url, { headers: DEFAULT_HEADERS })
    
    if (!response.ok) return null
    
    const data = await response.json()
    if (data.code !== '000000' || !data.data) return null
    
    return {
      roi: parseFloat(data.data.roi ?? 0),
      pnl: parseFloat(data.data.pnl ?? 0),
      winRate: parseFloat(data.data.winRate ?? 0),
      maxDrawdown: parseFloat(data.data.mdd ?? 0),
      sharpeRatio: parseFloat(data.data.sharpRatio ?? 0),
      totalTrades: parseInt(data.data.totalOrder ?? 0),
      winningTrades: parseInt(data.data.winOrders ?? 0),
    }
  } catch (e) {
    return null
  }
}

/**
 * 并行获取所有详情
 */
async function fetchAllDetails(traders, period, concurrency) {
  const limit = pLimit(concurrency)
  const startTime = Date.now()
  
  console.log(`\n🚀 并行获取详情 (并发: ${concurrency})...`)
  
  let completed = 0
  const total = traders.length
  
  const results = await Promise.all(
    traders.map((trader, index) =>
      limit(async () => {
        const detail = await fetchTraderDetail(trader.traderId, period)
        completed++
        
        if (completed % 20 === 0 || completed === total) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(`  进度: ${completed}/${total} | 耗时: ${elapsed}s`)
        }
        
        return {
          ...trader,
          ...(detail || {}),
          rank: index + 1,
        }
      })
    )
  )
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`  ✓ 详情获取完成，耗时: ${elapsed}s`)
  
  return results
}

/**
 * 批量保存数据
 */
async function saveTradersBatch(traders, period) {
  console.log(`\n💾 批量保存 ${traders.length} 条数据...`)
  
  const capturedAt = new Date().toISOString()
  
  // 1. 批量 upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: (t.nickname && !/^\d{10,}$/.test(t.nickname)) ? t.nickname : null,
    avatar_url: t.avatar || null,
    is_active: true,
  }))
  
  const { error: sourcesError } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  if (sourcesError) {
    console.log(`  ⚠ trader_sources: ${sourcesError.message}`)
  }
  
  // 2. 批量 insert trader_snapshots (包含 arena_score)
  const snapshotsData = traders.map(t => {
    const normalizedWinRate = t.winRate !== null && t.winRate !== undefined
      ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate)
      : null
    const { totalScore: arenaScore } = calculateArenaScore(t.roi || 0, t.pnl || 0, t.maxDrawdown, normalizedWinRate, period)
    
    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: t.rank,
      roi: t.roi || 0,
      pnl: t.pnl || 0,
      win_rate: normalizedWinRate,
      max_drawdown: t.maxDrawdown || 0,
      trades_count: t.totalTrades || null,
      followers: t.followers || 0,
      arena_score: arenaScore,
      captured_at: capturedAt,
    }
  })
  
  const { error: snapshotsError } = await supabase
    .from('trader_snapshots')
    .insert(snapshotsData)
  
  if (snapshotsError) {
    console.log(`  ⚠ trader_snapshots: ${snapshotsError.message}`)
    // 逐条重试
    let saved = 0
    for (const s of snapshotsData) {
      const { error } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved++
    }
    return saved
  }
  
  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

async function main() {
  const periods = getTargetPeriods()
  const concurrency = getConcurrency(10, 20)
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Binance Futures 纯 API 版本（超快）`)
  console.log(`========================================`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`并发: ${concurrency}`)
  console.log(`目标: ${TARGET_COUNT} 个交易员/周期`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(50)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`${'='.repeat(50)}`)
    
    // 1. 获取排行榜
    const traders = await fetchLeaderboard(period)
    
    if (traders.length === 0) {
      console.log(`\n⚠ ${period} 未获取到数据，跳过`)
      continue
    }
    
    // 2. 按 ROI 排序
    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    const top100 = traders.slice(0, TARGET_COUNT)
    
    console.log(`\n📊 ${period} TOP 5:`)
    top100.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
    })
    
    // 3. 获取详情
    const enrichedTraders = await fetchAllDetails(top100, period, concurrency)
    
    // 4. 保存
    const saved = await saveTradersBatch(enrichedTraders, period)
    results.push({ period, count: traders.length, saved, topRoi: top100[0]?.roi || 0 })
    
    console.log(`\n✅ ${period} 完成！保存了 ${saved} 条数据`)
    
    if (periods.indexOf(period) < periods.length - 1) {
      console.log(`\n⏳ 等待 3 秒后抓取下一个时间段...`)
      await sleep(3000)
    }
  }
  
  const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1)
  
  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ 全部完成！`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📊 抓取结果:`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
