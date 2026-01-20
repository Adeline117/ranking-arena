/**
 * Binance Futures Copy Trading - 纯 API 版本（超快）
 * 
 * 直接调用内部 API，不使用浏览器
 * 速度提升：比 Playwright 版本快 10-20 倍
 * 
 * 用法: node scripts/import_binance_futures_api.mjs [7D|30D|90D] [--concurrency=10]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import pLimit from 'p-limit'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'binance_futures'
const TARGET_COUNT = 100
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) return arg
  return '90D'
}

function getConcurrency() {
  const arg = process.argv.find(a => a.startsWith('--concurrency='))
  if (arg) {
    const val = parseInt(arg.split('=')[1])
    if (val >= 1 && val <= 20) return val
  }
  return 10 // API 版本可以更高并发
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
      const response = await fetch(LIST_API, {
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
        
        let winRate = parseFloat(item.winRate ?? 0)
        if (winRate > 1) winRate = winRate / 100
        
        traders.set(traderId, {
          traderId,
          nickname: item.nickName || item.nickname || null,
          avatar: item.userPhoto || null,
          roi: parseFloat(item.roi ?? 0),
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
    handle: t.nickname,
    profile_url: t.avatar,
    is_active: true,
  }))
  
  const { error: sourcesError } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  if (sourcesError) {
    console.log(`  ⚠ trader_sources: ${sourcesError.message}`)
  }
  
  // 2. 批量 insert trader_snapshots
  const snapshotsData = traders.map(t => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: t.rank,
    roi: t.roi || 0,
    pnl: t.pnl || 0,
    win_rate: t.winRate || 0,
    max_drawdown: t.maxDrawdown || 0,
    followers: t.followers || 0,
    captured_at: capturedAt,
  }))
  
  const { error: snapshotsError } = await supabase
    .from('trader_snapshots')
    .insert(snapshotsData)
  
  if (snapshotsError) {
    console.log(`  ⚠ trader_snapshots: ${snapshotsError.message}`)
    // 逐条重试
    let saved = 0
    for (const s of snapshotsData) {
      const { error } = await supabase.from('trader_snapshots').insert(s)
      if (!error) saved++
    }
    return saved
  }
  
  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

async function main() {
  const period = getTargetPeriod()
  const concurrency = getConcurrency()
  const startTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Binance Futures 纯 API 版本（超快）`)
  console.log(`========================================`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`周期: ${period}`)
  console.log(`并发: ${concurrency}`)
  console.log(`目标: ${TARGET_COUNT} 个交易员`)
  
  // 1. 获取排行榜
  const traders = await fetchLeaderboard(period)
  
  if (traders.length === 0) {
    console.log('\n⚠ 未获取到数据')
    process.exit(1)
  }
  
  // 2. 按 ROI 排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const top100 = traders.slice(0, TARGET_COUNT)
  
  console.log(`\n📊 TOP 5:`)
  top100.slice(0, 5).forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
  })
  
  // 3. 获取详情（可选，排行榜已有基本数据）
  const enrichedTraders = await fetchAllDetails(top100, period, concurrency)
  
  // 4. 保存
  const saved = await saveTradersBatch(enrichedTraders, period)
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  
  console.log(`\n========================================`)
  console.log(`✅ 完成！`)
  console.log(`   来源: ${SOURCE}`)
  console.log(`   周期: ${period}`)
  console.log(`   获取: ${traders.length}`)
  console.log(`   保存: ${saved}`)
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`========================================`)
}

main().catch(console.error)
