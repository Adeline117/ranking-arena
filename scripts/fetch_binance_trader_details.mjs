/**
 * Binance Copy Trading 数据抓取脚本 - 统一版
 *
 * 使用方法:
 *   node scripts/fetch_binance_trader_details.mjs [mode] [options]
 *
 * 模式 (mode):
 *   --standard   完整模式，包含 Puppeteer 获取仓位历史（默认）
 *   --fast       快速模式，高并发，跳过仓位历史
 *   --balanced   平衡模式，带重试和限流保护
 *
 * 选项 (options):
 *   --force      强制更新所有数据（不跳过已有数据）
 *   --limit=N    限制处理的交易员数量
 *   --concurrency=N  设置并发数（默认：fast=15, balanced=5, standard=1）
 *
 * 示例:
 *   node scripts/fetch_binance_trader_details.mjs --fast --limit=100
 *   node scripts/fetch_binance_trader_details.mjs --balanced --force
 *   node scripts/fetch_binance_trader_details.mjs --standard --concurrency=2
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

// ============================================
// 环境配置
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ============================================
// 常量配置
// ============================================

const BINANCE_API_BASE = 'https://www.binance.com'
const TIME_RANGES = ['7D', '30D', '90D']

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

// 模式配置
const MODE_CONFIG = {
  standard: { concurrency: 1, delay: 300, retries: 3, skipRecent: false, usePuppeteer: true },
  fast: { concurrency: 15, delay: 100, retries: 1, skipRecent: false, usePuppeteer: false },
  balanced: { concurrency: 5, delay: 300, retries: 3, skipRecent: true, usePuppeteer: false },
}

// ============================================
// 解析命令行参数
// ============================================

function parseArgs() {
  const args = process.argv.slice(2)

  // 确定模式
  let mode = 'standard'
  if (args.includes('--fast')) mode = 'fast'
  if (args.includes('--balanced')) mode = 'balanced'
  if (args.includes('--standard')) mode = 'standard'

  const config = { ...MODE_CONFIG[mode] }

  // 解析选项
  if (args.includes('--force')) {
    config.skipRecent = false
  }

  const limitArg = args.find(a => a.startsWith('--limit='))
  if (limitArg) {
    config.limit = parseInt(limitArg.split('=')[1])
  }

  const concurrencyArg = args.find(a => a.startsWith('--concurrency='))
  if (concurrencyArg) {
    config.concurrency = parseInt(concurrencyArg.split('=')[1])
  }

  config.mode = mode
  return config
}

// ============================================
// 工具函数
// ============================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 限流状态（用于 balanced 模式）
let rateLimitHits = 0
let currentDelay = 300

async function fetchApi(url, retries = 1) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: DEFAULT_HEADERS })

      if (response.status === 429) {
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

      // 成功时逐渐减少延迟
      if (currentDelay > 300) {
        currentDelay = Math.max(currentDelay * 0.9, 300)
      }

      if (json.code === '000000' && json.data !== null) {
        return json.data
      }
      return json.data || null
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

// ============================================
// 数据库操作
// ============================================

async function getAllBinanceTraders(limit) {
  let query = supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'binance_futures')
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  if (limit) {
    query = query.limit(limit)
  }

  const { data, error } = await query

  if (error) {
    console.error('获取交易员列表失败:', error.message)
    return []
  }
  return data || []
}

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

// ============================================
// 数据抓取
// ============================================

async function fetchAllDataForTrader(portfolioId, config) {
  const results = {}

  if (config.mode === 'fast') {
    // 快速模式：并行请求所有数据
    const promises = TIME_RANGES.flatMap(timeRange => [
      fetchApi(`${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${portfolioId}&timeRange=${timeRange}`, config.retries)
        .then(data => ({ type: 'perf', timeRange, data })),
      fetchApi(`${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance/coin?portfolioId=${portfolioId}&timeRange=${timeRange}`, config.retries)
        .then(data => ({ type: 'asset', timeRange, data })),
      fetchApi(`${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=ROI&portfolioId=${portfolioId}&timeRange=${timeRange}`, config.retries)
        .then(data => ({ type: 'roi', timeRange, data })),
      fetchApi(`${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=PNL&portfolioId=${portfolioId}&timeRange=${timeRange}`, config.retries)
        .then(data => ({ type: 'pnl', timeRange, data })),
    ])

    const allResults = await Promise.all(promises)

    for (const result of allResults) {
      if (!results[result.timeRange]) results[result.timeRange] = {}
      results[result.timeRange][result.type] = result.data
    }
  } else {
    // 标准/平衡模式：顺序请求
    for (const timeRange of TIME_RANGES) {
      results[timeRange] = {}

      results[timeRange].perf = await fetchApi(
        `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${portfolioId}&timeRange=${timeRange}`,
        config.retries
      )
      await delay(config.delay)

      results[timeRange].asset = await fetchApi(
        `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance/coin?portfolioId=${portfolioId}&timeRange=${timeRange}`,
        config.retries
      )
      await delay(config.delay)

      results[timeRange].roi = await fetchApi(
        `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=ROI&portfolioId=${portfolioId}&timeRange=${timeRange}`,
        config.retries
      )
      await delay(config.delay)

      results[timeRange].pnl = await fetchApi(
        `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=PNL&portfolioId=${portfolioId}&timeRange=${timeRange}`,
        config.retries
      )
      await delay(config.delay)
    }
  }

  return results
}

// Puppeteer 获取仓位历史（仅 standard 模式）
async function fetchPositionHistoryWithPuppeteer(portfolioId) {
  let puppeteer
  try {
    puppeteer = await import('puppeteer')
  } catch {
    console.log('    ⚠️ Puppeteer 未安装，跳过仓位历史')
    return []
  }

  console.log(`    获取 Position History (Puppeteer)...`)

  let browser
  try {
    browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    const page = await browser.newPage()
    await page.setUserAgent(DEFAULT_HEADERS['User-Agent'])

    let positions = []

    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('position-history') || url.includes('position/history')) {
        try {
          const data = await response.json()
          if (data.code === '000000' && data.data) {
            const list = data.data.list || data.data || []
            if (Array.isArray(list)) {
              positions = list
              console.log(`    ✓ Position History: ${positions.length} 条记录`)
            }
          }
        } catch {
          // 忽略
        }
      }
    })

    await page.goto(`https://www.binance.com/en/copy-trading/lead-details/${portfolioId}`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    })

    await delay(3000)

    // 尝试点击 Position/History tab
    try {
      const tabs = await page.$$('button, [role="tab"], .tab')
      for (const tab of tabs) {
        const text = await page.evaluate(el => el.textContent?.toLowerCase() || '', tab)
        if (text.includes('position') || text.includes('history')) {
          await tab.click()
          await delay(2000)
          break
        }
      }
    } catch {
      // 忽略
    }

    await browser.close()
    return positions

  } catch (error) {
    console.error(`    ✗ Position History 失败:`, error.message)
    if (browser) await browser.close()
    return []
  }
}

// ============================================
// 数据存储
// ============================================

async function storePerformance(portfolioId, timeRange, perfData, capturedAt) {
  if (!perfData) return false

  const offset = timeRange === '7D' ? -2000 : timeRange === '30D' ? -1000 : 0
  const adjustedCapturedAt = new Date(new Date(capturedAt).getTime() + offset).toISOString()

  // Snapshot
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

  // Stats detail
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

async function storePositionHistory(portfolioId, positions, capturedAt) {
  if (!positions || positions.length === 0) return false

  const positionItems = positions.map(item => {
    let direction = 'long'
    if (item.direction) {
      direction = item.direction.toLowerCase().includes('short') ? 'short' : 'long'
    } else if (item.side) {
      direction = item.side.toLowerCase().includes('sell') || item.side.toLowerCase().includes('short') ? 'short' : 'long'
    }

    return {
      source: 'binance_futures',
      source_trader_id: portfolioId,
      symbol: item.symbol || item.pair || '',
      direction,
      open_time: item.openTime ? new Date(parseInt(item.openTime)).toISOString() : null,
      close_time: item.closeTime ? new Date(parseInt(item.closeTime)).toISOString() : null,
      entry_price: parseFloat(item.entryPrice || item.openPrice || 0),
      exit_price: parseFloat(item.exitPrice || item.closePrice || 0),
      pnl_usd: parseFloat(item.pnl || item.realizedPnl || 0),
      pnl_pct: parseFloat(item.roe || item.pnlPct || 0),
      status: 'closed',
      captured_at: capturedAt,
    }
  }).filter(item => item.symbol && item.open_time)

  if (positionItems.length === 0) return false

  await supabase.from('trader_position_history')
    .upsert(positionItems, { onConflict: 'source,source_trader_id,symbol,open_time' })

  return true
}

// ============================================
// 处理交易员
// ============================================

async function processTrader(trader, capturedAt, config) {
  const portfolioId = trader.source_trader_id
  const handle = trader.handle || portfolioId

  // 检查是否跳过
  if (config.skipRecent) {
    const hasRecent = await hasRecentData(portfolioId)
    if (hasRecent) {
      return { status: 'skipped', handle }
    }
  }

  try {
    const allData = await fetchAllDataForTrader(portfolioId, config)

    const success = { perf: 0, asset: 0, chart: 0, position: 0 }

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

    // 仅 standard 模式获取仓位历史
    if (config.usePuppeteer) {
      const positions = await fetchPositionHistoryWithPuppeteer(portfolioId)
      if (positions.length > 0) {
        await storePositionHistory(portfolioId, positions, capturedAt)
        success.position = positions.length
      }
    }

    const hasData = success.perf > 0 || success.asset > 0 || success.chart > 0
    return { status: hasData ? 'success' : 'empty', handle, success }
  } catch (error) {
    return { status: 'error', handle, error: error.message }
  }
}

// ============================================
// 主函数
// ============================================

async function main() {
  const startTime = Date.now()
  const config = parseArgs()

  console.log(`=== Binance 交易员数据抓取 [${config.mode.toUpperCase()} 模式] ===`)
  console.log(`并发数: ${config.concurrency}`)
  console.log(`重试次数: ${config.retries}`)
  console.log(`跳过已有数据: ${config.skipRecent ? '是' : '否'}`)
  console.log(`获取仓位历史: ${config.usePuppeteer ? '是' : '否'}`)
  if (config.limit) console.log(`限制数量: ${config.limit}`)
  console.log('')

  console.log('获取交易员列表...')
  const traders = await getAllBinanceTraders(config.limit)
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
  for (let i = 0; i < traders.length; i += config.concurrency) {
    const batch = traders.slice(i, Math.min(i + config.concurrency, traders.length))

    const results = await Promise.all(
      batch.map(trader => processTrader(trader, capturedAt, config))
    )

    for (const result of results) {
      switch (result.status) {
        case 'success':
          successCount++
          const s = result.success
          const posInfo = config.usePuppeteer ? `, Pos=${s.position}` : ''
          console.log(`✓ ${result.handle}: Perf=${s.perf}/3, Asset=${s.asset}/3, Chart=${s.chart}/3${posInfo}`)
          break
        case 'skipped':
          skippedCount++
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
    const progress = Math.min(i + config.concurrency, traders.length)
    if (progress % 50 === 0 || progress === traders.length) {
      console.log(`--- 进度: ${progress}/${traders.length} (成功:${successCount}, 跳过:${skippedCount}, 空:${emptyCount}, 错误:${errorCount}) ---`)
    }

    // 批次间等待
    if (i + config.concurrency < traders.length) {
      await delay(config.mode === 'fast' ? 200 : config.delay * 2)
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log('\n========================================')
  console.log(`✅ 完成！`)
  console.log(`   成功: ${successCount}`)
  if (skippedCount > 0) console.log(`   跳过: ${skippedCount} (24小时内已有数据)`)
  if (emptyCount > 0) console.log(`   空数据: ${emptyCount}`)
  if (errorCount > 0) console.log(`   错误: ${errorCount}`)
  if (rateLimitHits > 0) console.log(`   限流次数: ${rateLimitHits}`)
  console.log(`⏱️ 耗时: ${duration} 秒`)
}

main()
