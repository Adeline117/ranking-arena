#!/usr/bin/env node
/**
 * 超快交易员详情抓取 (纯 API 版本)
 * 
 * 优化策略：
 * 1. 高并发 - 同时处理多个交易员
 * 2. 每个交易员的 API 请求并行执行
 * 3. 批量数据库操作
 * 4. 无浏览器开销
 * 
 * 用法:
 *   node scripts/fetch_details_fast.mjs                     # 所有来源
 *   node scripts/fetch_details_fast.mjs --source=binance   # 指定来源
 *   node scripts/fetch_details_fast.mjs --limit=100        # 限制数量
 *   node scripts/fetch_details_fast.mjs --concurrency=20   # 并发数
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

// API 配置
const API_CONFIGS = {
  binance_futures: {
    base: 'https://www.binance.com',
    endpoints: {
      performance: (id, period) => `/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${id}&timeRange=${period}`,
      asset: (id, period) => `/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance/coin?portfolioId=${id}&timeRange=${period}`,
      roi: (id, period) => `/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=ROI&portfolioId=${id}&timeRange=${period}`,
      pnl: (id, period) => `/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=PNL&portfolioId=${id}&timeRange=${period}`,
      positionHistory: (id) => `/bapi/futures/v1/public/future/copy-trade/lead-portfolio/position-history?portfolioId=${id}&pageNumber=1&pageSize=50`,
      currentPosition: (id) => `/bapi/futures/v1/public/future/copy-trade/lead-portfolio/current-position?portfolioId=${id}`,
    },
    parseResponse: (data) => data?.code === '000000' ? data.data : null,
  },
  binance_spot: {
    base: 'https://www.binance.com',
    endpoints: {
      performance: (id, period) => `/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${id}&timeRange=${period}`,
      positionHistory: (id) => `/bapi/futures/v1/public/future/copy-trade/lead-portfolio/position-history?portfolioId=${id}&pageNumber=1&pageSize=50`,
    },
    parseResponse: (data) => data?.code === '000000' ? data.data : null,
  },
  bitget_futures: {
    base: 'https://www.bitget.com',
    // Bitget API 需要浏览器会话，跳过纯 API
    endpoints: {},
    parseResponse: () => null,
  },
  bitget_spot: {
    base: 'https://www.bitget.com',
    endpoints: {},
    parseResponse: () => null,
  },
  bybit: {
    base: 'https://api2.bybit.com',
    endpoints: {
      // Bybit 公开 API
      traderInfo: (id) => `/copyTrading/api/v1/leader/detail?leaderId=${id}`,
    },
    parseResponse: (data) => data?.ret_code === 0 ? data.result : null,
  },
}

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

const TIME_RANGES = ['7D', '30D', '90D']

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2)
  const options = {
    source: null,
    limit: 200,
    concurrency: 15,
  }
  
  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      options.source = arg.split('=')[1]
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.split('=')[1]) || 200
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = parseInt(arg.split('=')[1]) || 15
    }
  }
  
  return options
}

// 通用 API 请求
async function fetchApi(url, config, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(config.base + url, { headers: DEFAULT_HEADERS })
      
      if (!response.ok) {
        if (response.status === 429) {
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        return null
      }
      
      const data = await response.json()
      return config.parseResponse(data)
    } catch (e) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 500))
    }
  }
  return null
}

// 获取交易员列表
async function getTraders(source, limit) {
  let query = supabase
    .from('trader_sources')
    .select('source, source_trader_id, handle')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)
  
  if (source) {
    // 支持部分匹配
    if (source === 'binance') {
      query = query.or('source.eq.binance_futures,source.eq.binance_spot,source.eq.binance_web3')
    } else if (source === 'bitget') {
      query = query.or('source.eq.bitget_futures,source.eq.bitget_spot')
    } else {
      query = query.eq('source', source)
    }
  } else {
    // 默认只处理支持 API 的来源
    query = query.in('source', ['binance_futures', 'binance_spot', 'bybit'])
  }
  
  const { data, error } = await query
  
  if (error) {
    console.error('获取交易员列表失败:', error)
    return []
  }
  
  return data || []
}

// 处理单个 Binance 交易员 (并行获取所有数据)
async function processBinanceTrader(traderId, source) {
  const config = API_CONFIGS[source]
  if (!config?.endpoints?.performance) return null
  
  const capturedAt = new Date().toISOString()
  const results = {
    stats: [],
    assets: [],
    curves: [],
    positions: [],
    portfolio: [],
  }
  
  // 并行获取所有时间段的数据
  const periodTasks = TIME_RANGES.map(async (period) => {
    const [perf, asset, roi, pnl] = await Promise.all([
      fetchApi(config.endpoints.performance(traderId, period), config),
      config.endpoints.asset ? fetchApi(config.endpoints.asset(traderId, period), config) : null,
      config.endpoints.roi ? fetchApi(config.endpoints.roi(traderId, period), config) : null,
      config.endpoints.pnl ? fetchApi(config.endpoints.pnl(traderId, period), config) : null,
    ])
    
    // Stats
    if (perf) {
      results.stats.push({
        source,
        source_trader_id: traderId,
        period,
        sharpe_ratio: parseFloat(perf.sharpRatio) || 0,
        max_drawdown: parseFloat(perf.mdd) || 0,
        copiers_pnl: parseFloat(perf.copierPnl) || 0,
        winning_positions: parseInt(perf.winOrders) || 0,
        total_positions: parseInt(perf.totalOrder) || 0,
        captured_at: capturedAt,
      })
    }
    
    // Assets
    if (asset?.data?.length > 0) {
      asset.data.forEach(a => {
        if (a.asset && parseFloat(a.volume) > 0) {
          results.assets.push({
            source,
            source_trader_id: traderId,
            period,
            symbol: a.asset,
            weight_pct: parseFloat(a.volume) || 0,
            captured_at: capturedAt,
          })
        }
      })
    }
    
    // Equity Curve
    if (roi?.length > 0) {
      const pnlMap = new Map((pnl || []).map(p => [p.dateTime, parseFloat(p.value) || 0]))
      roi.forEach(r => {
        const dataDate = new Date(r.dateTime).toISOString().split('T')[0]
        if (dataDate) {
          results.curves.push({
            source,
            source_trader_id: traderId,
            period,
            data_date: dataDate,
            roi_pct: parseFloat(r.value) || 0,
            pnl_usd: pnlMap.get(r.dateTime) || 0,
            captured_at: capturedAt,
          })
        }
      })
    }
  })
  
  // Position History & Current Positions (只调用一次)
  const [posHist, curPos] = await Promise.all([
    config.endpoints.positionHistory ? fetchApi(config.endpoints.positionHistory(traderId), config) : null,
    config.endpoints.currentPosition ? fetchApi(config.endpoints.currentPosition(traderId), config) : null,
    ...periodTasks,
  ])
  
  // Position History
  if (posHist?.list?.length > 0) {
    posHist.list.forEach(p => {
      if (p.symbol && p.openTime) {
        results.positions.push({
          source,
          source_trader_id: traderId,
          symbol: p.symbol,
          direction: (p.positionSide || '').toLowerCase().includes('short') ? 'short' : 'long',
          open_time: new Date(parseInt(p.openTime)).toISOString(),
          close_time: p.closeTime ? new Date(parseInt(p.closeTime)).toISOString() : null,
          entry_price: parseFloat(p.entryPrice) || 0,
          exit_price: parseFloat(p.markPrice || p.closePrice) || 0,
          pnl_usd: parseFloat(p.pnl) || 0,
          pnl_pct: parseFloat(p.roe) * 100 || 0,
          status: 'closed',
          captured_at: capturedAt,
        })
      }
    })
  }
  
  // Current Positions
  if (curPos?.length > 0) {
    curPos.forEach(p => {
      if (p.symbol) {
        results.portfolio.push({
          source,
          source_trader_id: traderId,
          symbol: p.symbol,
          direction: (p.positionSide || '').toLowerCase().includes('short') ? 'short' : 'long',
          entry_price: parseFloat(p.entryPrice) || 0,
          pnl: parseFloat(p.unrealizedProfit) || 0,
          invested_pct: parseFloat(p.positionAmt) || 0,
          captured_at: capturedAt,
        })
      }
    })
  }
  
  return results
}

// 批量保存数据
async function saveBatch(allResults) {
  const stats = []
  const assets = []
  const curves = []
  const positions = []
  const portfolios = []
  
  for (const r of allResults) {
    if (!r) continue
    stats.push(...r.stats)
    assets.push(...r.assets)
    curves.push(...r.curves)
    positions.push(...r.positions)
    portfolios.push(...r.portfolio)
  }
  
  const counts = { stats: 0, assets: 0, curves: 0, positions: 0, portfolios: 0 }
  
  // 批量插入 (分批处理大数组)
  const batchSize = 500
  
  // Stats
  if (stats.length > 0) {
    // 先删除旧数据
    const traderIds = [...new Set(stats.map(s => s.source_trader_id))]
    for (const source of [...new Set(stats.map(s => s.source))]) {
      await supabase.from('trader_stats_detail')
        .delete()
        .eq('source', source)
        .in('source_trader_id', traderIds)
    }
    
    for (let i = 0; i < stats.length; i += batchSize) {
      const batch = stats.slice(i, i + batchSize)
      const { error } = await supabase.from('trader_stats_detail').insert(batch)
      if (!error) counts.stats += batch.length
    }
  }
  
  // Assets
  if (assets.length > 0) {
    const traderIds = [...new Set(assets.map(a => a.source_trader_id))]
    for (const source of [...new Set(assets.map(a => a.source))]) {
      await supabase.from('trader_asset_breakdown')
        .delete()
        .eq('source', source)
        .in('source_trader_id', traderIds)
    }
    
    for (let i = 0; i < assets.length; i += batchSize) {
      const batch = assets.slice(i, i + batchSize)
      const { error } = await supabase.from('trader_asset_breakdown').insert(batch)
      if (!error) counts.assets += batch.length
    }
  }
  
  // Equity Curves
  if (curves.length > 0) {
    const traderIds = [...new Set(curves.map(c => c.source_trader_id))]
    for (const source of [...new Set(curves.map(c => c.source))]) {
      await supabase.from('trader_equity_curve')
        .delete()
        .eq('source', source)
        .in('source_trader_id', traderIds)
    }
    
    for (let i = 0; i < curves.length; i += batchSize) {
      const batch = curves.slice(i, i + batchSize)
      const { error } = await supabase.from('trader_equity_curve').insert(batch)
      if (!error) counts.curves += batch.length
    }
  }
  
  // Position History
  if (positions.length > 0) {
    for (let i = 0; i < positions.length; i += batchSize) {
      const batch = positions.slice(i, i + batchSize)
      const { error } = await supabase.from('trader_position_history')
        .upsert(batch, { onConflict: 'source,source_trader_id,symbol,open_time' })
      if (!error) counts.positions += batch.length
    }
  }
  
  // Portfolio (Current Positions)
  if (portfolios.length > 0) {
    const traderIds = [...new Set(portfolios.map(p => p.source_trader_id))]
    for (const source of [...new Set(portfolios.map(p => p.source))]) {
      await supabase.from('trader_portfolio')
        .delete()
        .eq('source', source)
        .in('source_trader_id', traderIds)
    }
    
    for (let i = 0; i < portfolios.length; i += batchSize) {
      const batch = portfolios.slice(i, i + batchSize)
      const { error } = await supabase.from('trader_portfolio').insert(batch)
      if (!error) counts.portfolios += batch.length
    }
  }
  
  return counts
}

async function main() {
  const options = parseArgs()
  const startTime = Date.now()
  
  console.log(`\n╔════════════════════════════════════════════════╗`)
  console.log(`║     🚀 超快详情抓取 (纯 API 版本)              ║`)
  console.log(`╚════════════════════════════════════════════════╝`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`来源: ${options.source || '所有支持 API 的来源'}`)
  console.log(`限制: ${options.limit} 个交易员`)
  console.log(`并发: ${options.concurrency}`)
  console.log(`────────────────────────────────────────────────`)
  
  // 获取交易员
  const traders = await getTraders(options.source, options.limit)
  console.log(`\n📋 找到 ${traders.length} 个交易员`)
  
  if (traders.length === 0) {
    console.log('没有交易员，请先运行排行榜抓取')
    return
  }
  
  // 按来源分组
  const bySource = new Map()
  for (const t of traders) {
    if (!bySource.has(t.source)) bySource.set(t.source, [])
    bySource.get(t.source).push(t)
  }
  
  console.log(`来源分布: ${[...bySource.entries()].map(([k, v]) => `${k}(${v.length})`).join(', ')}`)
  
  // 处理每个来源
  const limit = pLimit(options.concurrency)
  const allResults = []
  let processed = 0
  let success = 0
  
  for (const [source, sourceTraders] of bySource) {
    if (!API_CONFIGS[source]?.endpoints?.performance) {
      console.log(`\n⚠ 跳过 ${source} (不支持纯 API)`)
      continue
    }
    
    console.log(`\n🔄 处理 ${source} (${sourceTraders.length} 个)...`)
    const batchStartTime = Date.now()
    
    const tasks = sourceTraders.map(t => 
      limit(async () => {
        try {
          const result = await processBinanceTrader(t.source_trader_id, source)
          processed++
          if (result?.stats?.length > 0) success++
          
          // 进度显示
          if (processed % 20 === 0 || processed === traders.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            process.stdout.write(`\r  进度: ${processed}/${traders.length} | 成功: ${success} | 耗时: ${elapsed}s`)
          }
          
          return result
        } catch (e) {
          processed++
          return null
        }
      })
    )
    
    const sourceResults = await Promise.all(tasks)
    allResults.push(...sourceResults.filter(r => r))
    
    const batchElapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1)
    console.log(`\n  ✓ ${source} 完成，耗时: ${batchElapsed}s`)
  }
  
  // 批量保存
  console.log(`\n💾 批量保存数据...`)
  const saveStartTime = Date.now()
  const counts = await saveBatch(allResults)
  const saveElapsed = ((Date.now() - saveStartTime) / 1000).toFixed(1)
  
  console.log(`  保存完成，耗时: ${saveElapsed}s`)
  console.log(`  - Stats: ${counts.stats} 条`)
  console.log(`  - Assets: ${counts.assets} 条`)
  console.log(`  - Curves: ${counts.curves} 条`)
  console.log(`  - Positions: ${counts.positions} 条`)
  console.log(`  - Portfolio: ${counts.portfolios} 条`)
  
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  
  console.log(`\n╔════════════════════════════════════════════════╗`)
  console.log(`║              ✅ 完成！                         ║`)
  console.log(`╚════════════════════════════════════════════════╝`)
  console.log(`  交易员: ${processed}`)
  console.log(`  成功: ${success}`)
  console.log(`  总耗时: ${totalElapsed}s`)
  console.log(`  平均: ${(parseFloat(totalElapsed) / processed).toFixed(2)}s/人`)
  console.log(``)
}

main().catch(console.error)
