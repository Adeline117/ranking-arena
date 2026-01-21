/**
 * Binance Copy Trading 数据抓取脚本 - 修复版
 * 
 * 使用正确的 API endpoint 和字段映射
 * 
 * API Endpoints (已验证):
 * - Performance: /bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance
 *   返回: { timeRange, roi, pnl, mdd, copierPnl, winRate, winOrders, totalOrder, sharpRatio }
 * 
 * - Asset Breakdown: /bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance/coin
 *   返回: { timeRange, updateTime, data: [{ asset, volume }] }
 * 
 * - ROI Chart: /bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=ROI
 *   返回: [{ value, dataType, dateTime }]
 * 
 * - PnL Chart: /bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=PNL
 *   返回: [{ value, dataType, dateTime }]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
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

// HTTP 请求头
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/**
 * 延迟函数
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 发起 HTTP 请求
 */
async function fetchApi(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { headers: DEFAULT_HEADERS })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data = await response.json()
      
      if (data.code === '000000' && data.data !== null) {
        return data.data
      }
      
      return null
    } catch (error) {
      if (i < retries - 1) {
        await delay(1000 * (i + 1))
      }
    }
  }
  return null
}

/**
 * 获取所有 Binance 交易员列表
 */
async function getAllBinanceTraders() {
  const { data, error } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'binance_futures')
    .eq('is_active', true)
    .limit(200)

  if (error) {
    console.error('Error fetching traders:', error)
    return []
  }

  return data || []
}

/**
 * 获取 Performance 数据
 * API: /bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance
 * 返回: { timeRange, roi, pnl, mdd, copierPnl, winRate, winOrders, totalOrder, sharpRatio }
 */
async function fetchPerformance(portfolioId, timeRange) {
  const url = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${portfolioId}&timeRange=${timeRange}`
  const data = await fetchApi(url)
  
  if (data) {
    console.log(`    ✓ Performance ${timeRange}: ROI=${data.roi?.toFixed(2)}%, WinRate=${data.winRate?.toFixed(2)}%`)
  }
  
  return data
}

/**
 * 获取资产偏好数据 (Asset Breakdown)
 * API: /bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance/coin
 * 返回: { timeRange, updateTime, data: [{ asset, volume }] }
 * 注意: volume 是交易量占比百分比
 */
async function fetchAssetBreakdown(portfolioId, timeRange) {
  const url = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance/coin?portfolioId=${portfolioId}&timeRange=${timeRange}`
  const data = await fetchApi(url)
  
  if (data && data.data) {
    console.log(`    ✓ Asset Breakdown ${timeRange}: ${data.data.length} 资产`)
  }
  
  return data
}

/**
 * 获取 ROI 图表数据
 * API: /bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=ROI
 * 返回: [{ value, dataType, dateTime }]
 */
async function fetchRoiChart(portfolioId, timeRange) {
  const url = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=ROI&portfolioId=${portfolioId}&timeRange=${timeRange}`
  const data = await fetchApi(url)
  
  if (data && Array.isArray(data)) {
    console.log(`    ✓ ROI Chart ${timeRange}: ${data.length} 数据点`)
  }
  
  return data
}

/**
 * 获取 PnL 图表数据
 * API: /bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=PNL
 * 返回: [{ value, dataType, dateTime }]
 */
async function fetchPnlChart(portfolioId, timeRange) {
  const url = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=PNL&portfolioId=${portfolioId}&timeRange=${timeRange}`
  const data = await fetchApi(url)
  
  if (data && Array.isArray(data)) {
    console.log(`    ✓ PnL Chart ${timeRange}: ${data.length} 数据点`)
  }
  
  return data
}

/**
 * 使用 Puppeteer 获取 Position History
 * Position History API 需要通过网页会话访问
 */
async function fetchPositionHistoryWithPuppeteer(portfolioId) {
  console.log(`    获取 Position History (Puppeteer)...`)
  
  let browser
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    
    const page = await browser.newPage()
    
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )
    
    let positions = []
    
    // 监听 Position History API 响应
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
          // 忽略解析错误
        }
      }
    })
    
    // 访问交易员详情页
    const url = `https://www.binance.com/en/copy-trading/lead-details/${portfolioId}`
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
    
    // 等待页面加载完成
    await delay(3000)
    
    // 尝试点击 Position History 相关的按钮或 tab
    try {
      // 查找并点击 "Position" 或 "History" tab
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
    console.error(`    ✗ Position History 获取失败:`, error.message)
    if (browser) await browser.close()
    return []
  }
}

/**
 * 存储 Performance 数据到 trader_snapshots 和 trader_stats_detail
 * 注意：由于数据库唯一约束是 (source, source_trader_id, captured_at)，不包含 season_id
 * 所以我们需要为每个周期使用不同的 captured_at 时间戳
 */
async function storePerformance(portfolioId, timeRange, perfData, baseCapturedAt) {
  if (!perfData) return
  
  // 根据周期调整 captured_at，使每个周期有不同的时间戳
  // 7D: -2秒, 30D: -1秒, 90D: 0秒
  const offset = timeRange === '7D' ? -2000 : timeRange === '30D' ? -1000 : 0
  const capturedAt = new Date(new Date(baseCapturedAt).getTime() + offset).toISOString()
  
  // 存储到 trader_snapshots - 使用 delete + insert 避免约束问题
  const snapshotItem = {
    source: 'binance_futures',
    source_trader_id: portfolioId,
    season_id: timeRange,
    // ROI - Binance 返回的是百分比值，如 -14.86 表示 -14.86%
    roi: parseFloat(perfData.roi || 0),
    // PnL - 美元值
    pnl: parseFloat(perfData.pnl || 0),
    // Win Rate - 百分比值
    win_rate: parseFloat(perfData.winRate || 0),
    // Max Drawdown - 百分比值
    max_drawdown: parseFloat(perfData.mdd || 0),
    // Followers/Copiers
    followers: 0, // 需要从 detail API 获取
    captured_at: capturedAt,
  }

  // 先删除相同 source + source_trader_id + season_id 的旧数据
  await supabase
    .from('trader_snapshots')
    .delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('season_id', timeRange)

  // 使用 insert 而不是 upsert，因为我们已经删除了旧数据
  const { error: snapshotError } = await supabase
    .from('trader_snapshots')
    .insert(snapshotItem)

  if (snapshotError) {
    console.error(`    ✗ 存储 Snapshot ${timeRange} 失败:`, snapshotError.message)
  } else {
    console.log(`    ✓ Snapshot ${timeRange} 已存储`)
  }
  
  // 存储到 trader_stats_detail - 同样使用 delete + insert
  const statsItem = {
    source: 'binance_futures',
    source_trader_id: portfolioId,
    period: timeRange,
    sharpe_ratio: parseFloat(perfData.sharpRatio || 0),
    max_drawdown: parseFloat(perfData.mdd || 0),
    copiers_pnl: parseFloat(perfData.copierPnl || 0),
    winning_positions: parseInt(perfData.winOrders || 0),
    total_positions: parseInt(perfData.totalOrder || 0),
    captured_at: capturedAt,
  }

  // 先删除相同 source + source_trader_id + period 的旧数据
  await supabase
    .from('trader_stats_detail')
    .delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('period', timeRange)

  // 使用 insert 而不是 upsert，因为我们已经删除了旧数据
  const { error: statsError } = await supabase
    .from('trader_stats_detail')
    .insert(statsItem)

  if (statsError) {
    console.error(`    ✗ 存储 Stats ${timeRange} 失败:`, statsError.message)
  } else {
    console.log(`    ✓ Stats ${timeRange} 已存储 (Sharpe: ${statsItem.sharpe_ratio}, Win: ${statsItem.winning_positions}/${statsItem.total_positions})`)
  }
}

/**
 * 存储资产偏好数据到 trader_asset_breakdown
 * Binance 返回的 volume 是交易量占比百分比
 */
async function storeAssetBreakdown(portfolioId, timeRange, assetData, capturedAt) {
  if (!assetData || !assetData.data || !Array.isArray(assetData.data)) return
  
  const assetItems = assetData.data.map(item => ({
    source: 'binance_futures',
    source_trader_id: portfolioId,
    period: timeRange,
    // asset 是交易对/资产名称，如 "BTC", "ETH"
    symbol: item.asset || '',
    // volume 是交易量占比百分比，如 80.42 表示 80.42%
    weight_pct: parseFloat(item.volume || 0),
    captured_at: capturedAt,
  })).filter(item => item.symbol && item.weight_pct > 0)

  if (assetItems.length === 0) return

  // 先删除该时间段的旧数据
  await supabase
    .from('trader_asset_breakdown')
    .delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('period', timeRange)

  const { error } = await supabase
    .from('trader_asset_breakdown')
    .insert(assetItems)

  if (error) {
    console.error(`    ✗ 存储 Asset Breakdown ${timeRange} 失败:`, error.message)
  }
}

/**
 * 存储 ROI 曲线数据到 trader_equity_curve
 */
async function storeEquityCurve(portfolioId, timeRange, roiData, pnlData, capturedAt) {
  if (!roiData || !Array.isArray(roiData) || roiData.length === 0) return
  
  // 创建 PnL 数据的映射表
  const pnlMap = new Map()
  if (pnlData && Array.isArray(pnlData)) {
    pnlData.forEach(item => {
      pnlMap.set(item.dateTime, item.value)
    })
  }
  
  const curveItems = roiData.map(item => {
    // dateTime 是毫秒时间戳
    const dateObj = new Date(item.dateTime)
    const dataDate = dateObj.toISOString().split('T')[0]
    
    return {
      source: 'binance_futures',
      source_trader_id: portfolioId,
      period: timeRange,
      data_date: dataDate,
      // value 是 ROI 百分比值
      roi_pct: parseFloat(item.value || 0),
      // 从 PnL 数据中获取对应的 PnL 值
      pnl_usd: parseFloat(pnlMap.get(item.dateTime) || 0),
      captured_at: capturedAt,
    }
  }).filter(item => item.data_date)

  if (curveItems.length === 0) return

  // 先删除该时间段的旧数据
  await supabase
    .from('trader_equity_curve')
    .delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
    .eq('period', timeRange)

  const { error } = await supabase
    .from('trader_equity_curve')
    .insert(curveItems)

  if (error) {
    console.error(`    ✗ 存储 Equity Curve ${timeRange} 失败:`, error.message)
  }
}

/**
 * 存储仓位历史到 trader_position_history
 */
async function storePositionHistory(portfolioId, positions, capturedAt) {
  if (!positions || positions.length === 0) return
  
  const positionItems = positions.map(item => {
    // 解析方向
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
      direction: direction,
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

  if (positionItems.length === 0) return

  const { error } = await supabase
    .from('trader_position_history')
    .upsert(positionItems, { onConflict: 'source,source_trader_id,symbol,open_time' })

  if (error) {
    console.error(`    ✗ 存储 Position History 失败:`, error.message)
  }
}

/**
 * 处理单个交易员
 */
async function processTrader(trader, capturedAt) {
  const portfolioId = trader.source_trader_id
  console.log(`\n处理交易员: ${trader.handle || portfolioId}`)
  
  // 遍历所有时间段获取数据
  for (const timeRange of TIME_RANGES) {
    console.log(`  === ${timeRange} ===`)
    
    // 1. 获取并存储 Performance
    const perfData = await fetchPerformance(portfolioId, timeRange)
    await storePerformance(portfolioId, timeRange, perfData, capturedAt)
    await delay(300)
    
    // 2. 获取并存储 Asset Breakdown
    const assetData = await fetchAssetBreakdown(portfolioId, timeRange)
    await storeAssetBreakdown(portfolioId, timeRange, assetData, capturedAt)
    await delay(300)
    
    // 3. 获取 ROI 和 PnL 图表数据
    const roiData = await fetchRoiChart(portfolioId, timeRange)
    const pnlData = await fetchPnlChart(portfolioId, timeRange)
    await storeEquityCurve(portfolioId, timeRange, roiData, pnlData, capturedAt)
    await delay(300)
  }
  
  // 4. 获取 Position History (使用 Puppeteer)
  const positions = await fetchPositionHistoryWithPuppeteer(portfolioId)
  await storePositionHistory(portfolioId, positions, capturedAt)
}

/**
 * 主函数
 */
async function main() {
  try {
    console.log('=== Binance 交易员数据抓取 (修复版) ===')
    console.log('数据类型: Performance, Asset Breakdown, ROI/PnL Chart, Position History')
    console.log('')

    // 获取所有交易员
    console.log('获取交易员列表...')
    const traders = await getAllBinanceTraders()
    console.log(`找到 ${traders.length} 个交易员`)
    
    if (traders.length === 0) {
      console.log('没有交易员可抓取')
      return
    }

    const capturedAt = new Date().toISOString()
    console.log(`统一 captured_at: ${capturedAt}`)

    let successCount = 0
    let failCount = 0

    // 处理每个交易员
    for (let i = 0; i < traders.length; i++) {
      const trader = traders[i]
      console.log(`\n[${i + 1}/${traders.length}] ================================`)
      
      try {
        await processTrader(trader, capturedAt)
        successCount++
      } catch (error) {
        console.error(`  ✗ 处理失败:`, error.message)
        failCount++
      }
      
      // 请求间隔
      if (i < traders.length - 1) {
        await delay(1500)
      }
    }

    console.log('\n========================================')
    console.log(`✅ 完成！成功: ${successCount}, 失败: ${failCount}`)

  } catch (error) {
    console.error('执行失败:', error)
    process.exit(1)
  }
}

main()
