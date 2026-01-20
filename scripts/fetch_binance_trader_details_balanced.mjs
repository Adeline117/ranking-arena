/**
 * Binance Copy Trading 数据抓取脚本 - 平衡版
 * 
 * 优化点：
 * 1. 适中并发 (5) 避免限流
 * 2. 失败重试机制 (最多3次)
 * 3. 跳过24小时内已有数据的交易员
 * 4. 智能延迟（限流时自动增加等待）
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

const BINANCE_API_BASE = 'https://www.binance.com'
const TIME_RANGES = ['7D', '30D', '90D']
const CONCURRENCY = 5
const MAX_RETRIES = 3
const BASE_DELAY = 300

// 限流检测
let rateLimitHits = 0
let currentDelay = BASE_DELAY

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        }
      })
      
      if (response.status === 429) {
        // 限流，增加延迟
        rateLimitHits++
        currentDelay = Math.min(currentDelay * 1.5, 3000)
        console.log(`    ⚠️ 限流，等待 ${currentDelay}ms...`)
        await delay(currentDelay)
        continue
      }
      
      if (!response.ok) {
        if (attempt < retries) {
          await delay(500 * attempt)
          continue
        }
        return null
      }
      
      const json = await response.json()
      
      // 成功，逐渐减少延迟
      if (currentDelay > BASE_DELAY) {
        currentDelay = Math.max(currentDelay * 0.9, BASE_DELAY)
      }
      
      if (json.code === '000000' && json.data) {
        return json.data
      }
      return json
    } catch (error) {
      if (attempt < retries) {
        await delay(500 * attempt)
        continue
      }
      return null
    }
  }
  return null
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

// 检查交易员是否有最近的数据
async function hasRecentData(portfolioId) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  
  const { data } = await supabase
    .from('trader_stats_detail')
    .select('id')
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .gte('captured_at', yesterday)
    .limit(1)
  
  return data && data.length > 0
}

async function fetchAllDataForTrader(portfolioId) {
  const results = {}
  
  for (const timeRange of TIME_RANGES) {
    results[timeRange] = {}
    
    // 按顺序请求，避免同时发太多请求
    const perf = await fetchWithRetry(
      `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${portfolioId}&timeRange=${timeRange}`
    )
    results[timeRange].perf = perf
    await delay(currentDelay)
    
    const asset = await fetchWithRetry(
      `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance/coin?portfolioId=${portfolioId}&timeRange=${timeRange}`
    )
    results[timeRange].asset = asset
    await delay(currentDelay)
    
    const roi = await fetchWithRetry(
      `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=ROI&portfolioId=${portfolioId}&timeRange=${timeRange}`
    )
    results[timeRange].roi = roi
    await delay(currentDelay)
    
    const pnl = await fetchWithRetry(
      `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=PNL&portfolioId=${portfolioId}&timeRange=${timeRange}`
    )
    results[timeRange].pnl = pnl
    await delay(currentDelay)
  }
  
  return results
}

async function storePerformance(portfolioId, timeRange, perfData, capturedAt) {
  if (!perfData) return false
  
  const offset = timeRange === '7D' ? -2000 : timeRange === '30D' ? -1000 : 0
  const adjustedCapturedAt = new Date(new Date(capturedAt).getTime() + offset).toISOString()
  
  await supabase.from('trader_snapshots').delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('season_id', timeRange)

  await supabase.from('trader_snapshots').insert({
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

  await supabase.from('trader_stats_detail').delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('period', timeRange)

  await supabase.from('trader_stats_detail').insert({
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
  
  await supabase.from('trader_asset_breakdown').delete()
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
  
  await supabase.from('trader_equity_curve').delete()
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

async function processTrader(trader, capturedAt, skipRecent = true) {
  const portfolioId = trader.source_trader_id
  const handle = trader.handle || portfolioId
  
  // 检查是否有最近数据
  if (skipRecent) {
    const hasRecent = await hasRecentData(portfolioId)
    if (hasRecent) {
      return { status: 'skipped', handle }
    }
  }
  
  try {
    const allData = await fetchAllDataForTrader(portfolioId)
    
    let success = { perf: 0, asset: 0, chart: 0 }
    
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
    
    const hasData = success.perf > 0 || success.asset > 0 || success.chart > 0
    return { 
      status: hasData ? 'success' : 'empty', 
      handle, 
      success 
    }
  } catch (error) {
    return { status: 'error', handle, error: error.message }
  }
}

async function processInBatches(items, batchSize, processor) {
  const results = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(processor))
    results.push(...batchResults)
    
    // 批次间延迟
    if (i + batchSize < items.length) {
      await delay(currentDelay * 2)
    }
  }
  return results
}

async function main() {
  const startTime = Date.now()
  const skipRecent = process.argv.includes('--force') ? false : true
  
  console.log('=== Binance 平衡版数据抓取 ===')
  console.log(`并发数: ${CONCURRENCY}`)
  console.log(`重试次数: ${MAX_RETRIES}`)
  console.log(`跳过已有数据: ${skipRecent ? '是' : '否 (--force 模式)'}`)
  console.log('')

  console.log('获取交易员列表...')
  const traders = await getAllBinanceTraders()
  console.log(`找到 ${traders.length} 个交易员\n`)
  
  if (traders.length === 0) {
    console.log('没有交易员可抓取')
    return
  }

  const capturedAt = new Date().toISOString()
  
  let successCount = 0
  let skippedCount = 0
  let emptyCount = 0
  let errorCount = 0
  
  // 分批处理
  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    const batch = traders.slice(i, Math.min(i + CONCURRENCY, traders.length))
    
    const results = await Promise.all(
      batch.map(trader => processTrader(trader, capturedAt, skipRecent))
    )
    
    for (const result of results) {
      switch (result.status) {
        case 'success':
          successCount++
          console.log(`✓ ${result.handle}: Perf=${result.success.perf}/3, Asset=${result.success.asset}/3, Chart=${result.success.chart}/3`)
          break
        case 'skipped':
          skippedCount++
          // 不打印跳过的
          break
        case 'empty':
          emptyCount++
          console.log(`○ ${result.handle}: 无数据`)
          break
        case 'error':
          errorCount++
          console.log(`✗ ${result.handle}: ${result.error}`)
          break
      }
    }
    
    // 进度
    const progress = Math.min(i + CONCURRENCY, traders.length)
    if (progress % 50 === 0 || progress === traders.length) {
      console.log(`--- 进度: ${progress}/${traders.length} (成功:${successCount}, 跳过:${skippedCount}, 空:${emptyCount}, 错误:${errorCount}) ---`)
    }
    
    // 批次间等待
    if (i + CONCURRENCY < traders.length) {
      await delay(currentDelay * 3)
    }
  }
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  
  console.log('\n========================================')
  console.log(`✅ 完成！`)
  console.log(`   成功: ${successCount}`)
  console.log(`   跳过: ${skippedCount} (24小时内已有数据)`)
  console.log(`   空数据: ${emptyCount}`)
  console.log(`   错误: ${errorCount}`)
  console.log(`   限流次数: ${rateLimitHits}`)
  console.log(`⏱️ 耗时: ${duration} 秒`)
}

main()
