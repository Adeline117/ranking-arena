/**
 * Binance Copy Trading 数据抓取脚本 - 快速版
 * 
 * 优化点：
 * 1. 跳过 Puppeteer 仓位历史（最慢的部分）
 * 2. 并行 API 请求
 * 3. 并发处理多个交易员
 * 4. 减少延迟
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Binance API Base URL
const BINANCE_API_BASE = 'https://www.binance.com'

// 时间段配置
const TIME_RANGES = ['7D', '30D', '90D']

// 并发数量 - 增加到 15 以提高速度
const CONCURRENCY = 15

// HTTP 请求头
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchApi(url) {
  try {
    const response = await fetch(url, { headers: DEFAULT_HEADERS })
    if (!response.ok) return null
    const json = await response.json()
    if (json.code === '000000' && json.data) {
      return json.data
    }
    return json
  } catch {
    return null
  }
}

async function getAllBinanceTraders() {
  const { data, error } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'binance_futures')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('获取交易员列表失败:', error.message)
    return []
  }
  return data || []
}

// 并行获取所有时间段的数据
async function fetchAllDataForTrader(portfolioId) {
  const results = {}
  
  // 并行获取所有时间段的所有数据
  const promises = TIME_RANGES.flatMap(timeRange => [
    fetchApi(`${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${portfolioId}&timeRange=${timeRange}`)
      .then(data => ({ type: 'perf', timeRange, data })),
    fetchApi(`${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance/coin?portfolioId=${portfolioId}&timeRange=${timeRange}`)
      .then(data => ({ type: 'asset', timeRange, data })),
    fetchApi(`${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=ROI&portfolioId=${portfolioId}&timeRange=${timeRange}`)
      .then(data => ({ type: 'roi', timeRange, data })),
    fetchApi(`${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=PNL&portfolioId=${portfolioId}&timeRange=${timeRange}`)
      .then(data => ({ type: 'pnl', timeRange, data })),
  ])

  const allResults = await Promise.all(promises)
  
  for (const result of allResults) {
    if (!results[result.timeRange]) {
      results[result.timeRange] = {}
    }
    results[result.timeRange][result.type] = result.data
  }
  
  return results
}

async function storePerformance(portfolioId, timeRange, perfData, capturedAt) {
  if (!perfData) return false
  
  const offset = timeRange === '7D' ? -2000 : timeRange === '30D' ? -1000 : 0
  const adjustedCapturedAt = new Date(new Date(capturedAt).getTime() + offset).toISOString()
  
  // Snapshot
  await supabase
    .from('trader_snapshots')
    .delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('season_id', timeRange)

  await supabase
    .from('trader_snapshots')
    .insert({
      source: 'binance_futures',
      source_trader_id: portfolioId,
      season_id: timeRange,
      roi: parseFloat(perfData.roi || 0),
      pnl: parseFloat(perfData.pnl || 0),
      win_rate: parseFloat(perfData.winRate || 0),
      max_drawdown: parseFloat(perfData.mdd || 0),
      followers: 0,
      captured_at: adjustedCapturedAt,
    })

  // Stats detail
  await supabase
    .from('trader_stats_detail')
    .delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('period', timeRange)

  await supabase
    .from('trader_stats_detail')
    .insert({
      source: 'binance_futures',
      source_trader_id: portfolioId,
      period: timeRange,
      sharpe_ratio: parseFloat(perfData.sharpRatio || 0),
      max_drawdown: parseFloat(perfData.mdd || 0),
      copiers_pnl: parseFloat(perfData.copierPnl || 0),
      winning_positions: parseInt(perfData.winOrders || 0),
      total_positions: parseInt(perfData.totalOrder || 0),
      captured_at: adjustedCapturedAt,
    })
  
  return true
}

async function storeAssetBreakdown(portfolioId, timeRange, assetData, capturedAt) {
  if (!assetData?.data?.length) return false
  
  await supabase
    .from('trader_asset_breakdown')
    .delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('period', timeRange)

  const items = assetData.data.map(item => ({
    source: 'binance_futures',
    source_trader_id: portfolioId,
    period: timeRange,
    symbol: item.asset || item.symbol || 'UNKNOWN',
    weight_pct: parseFloat(item.volume || item.weight || 0),
    captured_at: capturedAt,
  }))

  await supabase.from('trader_asset_breakdown').insert(items)
  return true
}

async function storeEquityCurve(portfolioId, timeRange, roiData, pnlData, capturedAt) {
  if (!roiData?.length && !pnlData?.length) return false
  
  const roiMap = new Map()
  const pnlMap = new Map()
  
  if (Array.isArray(roiData)) {
    roiData.forEach(item => {
      const date = new Date(parseInt(item.dateTime)).toISOString().split('T')[0]
      roiMap.set(date, parseFloat(item.value || 0))
    })
  }
  
  if (Array.isArray(pnlData)) {
    pnlData.forEach(item => {
      const date = new Date(parseInt(item.dateTime)).toISOString().split('T')[0]
      pnlMap.set(date, parseFloat(item.value || 0))
    })
  }
  
  const allDates = new Set([...roiMap.keys(), ...pnlMap.keys()])
  if (allDates.size === 0) return false
  
  await supabase
    .from('trader_equity_curve')
    .delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('period', timeRange)

  const items = Array.from(allDates).map(date => ({
    source: 'binance_futures',
    source_trader_id: portfolioId,
    period: timeRange,
    data_date: date,
    roi_pct: roiMap.get(date) ?? null,
    pnl_usd: pnlMap.get(date) ?? null,
    captured_at: capturedAt,
  }))

  await supabase.from('trader_equity_curve').insert(items)
  return true
}

async function processTrader(trader, capturedAt) {
  const portfolioId = trader.source_trader_id
  const handle = trader.handle || portfolioId
  
  try {
    // 并行获取所有数据
    const allData = await fetchAllDataForTrader(portfolioId)
    
    let success = { perf: 0, asset: 0, chart: 0 }
    
    // 存储所有时间段的数据
    for (const timeRange of TIME_RANGES) {
      const data = allData[timeRange] || {}
      
      if (data.perf) {
        await storePerformance(portfolioId, timeRange, data.perf, capturedAt)
        success.perf++
      }
      
      if (data.asset) {
        await storeAssetBreakdown(portfolioId, timeRange, data.asset, capturedAt)
        success.asset++
      }
      
      if (data.roi || data.pnl) {
        await storeEquityCurve(portfolioId, timeRange, data.roi, data.pnl, capturedAt)
        success.chart++
      }
    }
    
    console.log(`✓ ${handle}: Perf=${success.perf}/3, Asset=${success.asset}/3, Chart=${success.chart}/3`)
    return true
  } catch (error) {
    console.log(`✗ ${handle}: ${error.message}`)
    return false
  }
}

// 并发处理函数
async function processInBatches(items, batchSize, processor) {
  const results = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(processor))
    results.push(...batchResults)
    
    // 批次间延迟 - 减少到 200ms
    if (i + batchSize < items.length) {
      await delay(200)
    }
  }
  return results
}

async function main() {
  const startTime = Date.now()
  
  console.log('=== Binance 快速数据抓取 ===')
  console.log(`并发数: ${CONCURRENCY}`)
  console.log('')

  console.log('获取交易员列表...')
  const traders = await getAllBinanceTraders()
  console.log(`找到 ${traders.length} 个交易员\n`)
  
  if (traders.length === 0) {
    console.log('没有交易员可抓取')
    return
  }

  const capturedAt = new Date().toISOString()
  
  // 并发处理
  const results = await processInBatches(
    traders,
    CONCURRENCY,
    (trader) => processTrader(trader, capturedAt)
  )
  
  const successCount = results.filter(r => r).length
  const failCount = results.filter(r => !r).length
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  
  console.log('\n========================================')
  console.log(`✅ 完成！成功: ${successCount}, 失败: ${failCount}`)
  console.log(`⏱️ 耗时: ${duration} 秒`)
}

main()
