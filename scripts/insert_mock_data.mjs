/**
 * 插入模拟数据脚本
 * 用于测试 UI 显示效果
 * 运行: node scripts/insert_mock_data.mjs
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

const capturedAt = new Date().toISOString()

// 获取前 N 名交易员
async function getTopTraders(limit = 10) {
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, source, roi')
    .eq('source', 'binance')
    .order('roi', { ascending: false })
    .limit(limit * 3) // 多取一些，去重后可能不够

  if (error) {
    console.error('获取交易员失败:', error.message)
    return []
  }

  // 去重
  const uniqueTraders = [...new Map(data.map(t => [t.source_trader_id, t])).values()]
  return uniqueTraders.slice(0, limit)
}

// 为交易员生成模拟数据
function generateMockData(traderId) {
  // 模拟资产偏好
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT']
  const assetBreakdown = {
    '90D': generateAssetWeights(symbols, 6),
    '30D': generateAssetWeights(symbols, 5),
    '7D': generateAssetWeights(symbols, 4),
  }

  // 模拟收益率曲线
  const equityCurve = {
    '90D': generateEquityCurve(90),
    '30D': generateEquityCurve(30),
    '7D': generateEquityCurve(7),
  }

  // 模拟详细统计
  const statsDetail = {
    sharpe_ratio: (Math.random() * 3 + 0.5).toFixed(2),
    copiers_count: Math.floor(Math.random() * 2000) + 100,
    copiers_pnl: (Math.random() * 200000 - 50000).toFixed(2),
    winning_positions: Math.floor(Math.random() * 200) + 50,
    total_positions: Math.floor(Math.random() * 250) + 80,
    avg_holding_time_hours: Math.floor(Math.random() * 72) + 1,
    avg_profit: (Math.random() * 500 + 50).toFixed(2),
    avg_loss: -(Math.random() * 300 + 30).toFixed(2),
  }

  // 模拟仓位历史
  const positionHistory = generatePositionHistory(symbols, 20)

  // 模拟当前持仓
  const portfolio = generatePortfolio(symbols, 3)

  return { traderId, assetBreakdown, equityCurve, statsDetail, positionHistory, portfolio }
}

function generateAssetWeights(symbols, count) {
  const selected = symbols.slice(0, count)
  let remaining = 100
  return selected.map((symbol, i) => {
    const isLast = i === selected.length - 1
    const weight = isLast ? remaining : Math.min(remaining - (selected.length - i - 1), Math.random() * (remaining * 0.6) + 5)
    remaining -= weight
    return { symbol, weight_pct: parseFloat(weight.toFixed(2)) }
  }).sort((a, b) => b.weight_pct - a.weight_pct)
}

function generateEquityCurve(days) {
  const points = []
  let baseRoi = Math.random() * 500 + 100
  let basePnl = Math.random() * 5000 + 1000

  for (let i = days; i >= 0; i--) {
    const date = new Date()
    date.setDate(date.getDate() - i)
    const dateStr = date.toISOString().split('T')[0]

    // 添加一些波动
    baseRoi += (Math.random() - 0.4) * 50
    basePnl += (Math.random() - 0.4) * 500

    points.push({
      data_date: dateStr,
      roi_pct: parseFloat(Math.max(0, baseRoi).toFixed(2)),
      pnl_usd: parseFloat(basePnl.toFixed(2)),
    })
  }
  return points
}

function generatePositionHistory(symbols, count) {
  const positions = []
  for (let i = 0; i < count; i++) {
    const symbol = symbols[Math.floor(Math.random() * symbols.length)]
    const direction = Math.random() > 0.5 ? 'long' : 'short'
    const openTime = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000)
    const closeTime = new Date(openTime.getTime() + Math.random() * 7 * 24 * 60 * 60 * 1000)
    const entryPrice = Math.random() * 50000 + 100
    const pnlPct = (Math.random() - 0.3) * 50 // 偏向盈利

    positions.push({
      symbol,
      direction,
      position_type: 'perpetual',
      margin_mode: Math.random() > 0.3 ? 'cross' : 'isolated',
      open_time: openTime.toISOString(),
      close_time: closeTime.toISOString(),
      entry_price: parseFloat(entryPrice.toFixed(2)),
      exit_price: parseFloat((entryPrice * (1 + pnlPct / 100)).toFixed(2)),
      max_position_size: parseFloat((Math.random() * 10 + 0.1).toFixed(4)),
      closed_size: parseFloat((Math.random() * 10 + 0.1).toFixed(4)),
      pnl_usd: parseFloat((Math.random() * 2000 - 500).toFixed(2)),
      pnl_pct: parseFloat(pnlPct.toFixed(2)),
      status: 'closed',
    })
  }
  return positions.sort((a, b) => new Date(b.close_time) - new Date(a.close_time))
}

function generatePortfolio(symbols, count) {
  const selected = symbols.slice(0, count)
  return selected.map(symbol => ({
    symbol,
    direction: Math.random() > 0.5 ? 'long' : 'short',
    invested_pct: parseFloat((Math.random() * 30 + 5).toFixed(2)),
    entry_price: parseFloat((Math.random() * 50000 + 100).toFixed(2)),
    pnl: parseFloat((Math.random() * 1000 - 200).toFixed(2)),
  }))
}

// 插入数据到数据库
async function insertMockData(mockData) {
  const { traderId, assetBreakdown, equityCurve, statsDetail, positionHistory, portfolio } = mockData

  console.log(`  插入数据: ${traderId}`)

  // 1. 资产偏好
  for (const period of ['90D', '30D', '7D']) {
    const items = assetBreakdown[period].map(item => ({
      source: 'binance',
      source_trader_id: traderId,
      period,
      symbol: item.symbol,
      weight_pct: item.weight_pct,
      captured_at: capturedAt,
    }))

    if (items.length > 0) {
      const { error } = await supabase.from('trader_asset_breakdown').upsert(items, {
        onConflict: 'source,source_trader_id,period,symbol,captured_at'
      })
      if (error) console.log(`    ✗ 资产偏好(${period}): ${error.message}`)
      else console.log(`    ✓ 资产偏好(${period}): ${items.length} 条`)
    }
  }

  // 2. 收益率曲线
  for (const period of ['90D', '30D', '7D']) {
    const items = equityCurve[period].map(item => ({
      source: 'binance',
      source_trader_id: traderId,
      period,
      data_date: item.data_date,
      roi_pct: item.roi_pct,
      pnl_usd: item.pnl_usd,
      captured_at: capturedAt,
    }))

    if (items.length > 0) {
      const { error } = await supabase.from('trader_equity_curve').upsert(items, {
        onConflict: 'source,source_trader_id,period,data_date'
      })
      if (error) console.log(`    ✗ 收益率曲线(${period}): ${error.message}`)
      else console.log(`    ✓ 收益率曲线(${period}): ${items.length} 条`)
    }
  }

  // 3. 详细统计
  for (const period of ['90D', '30D', '7D']) {
    const item = {
      source: 'binance',
      source_trader_id: traderId,
      period,
      ...statsDetail,
      captured_at: capturedAt,
    }

    const { error } = await supabase.from('trader_stats_detail').upsert(item, {
      onConflict: 'source,source_trader_id,period,captured_at'
    })
    if (error) console.log(`    ✗ 详细统计(${period}): ${error.message}`)
    else console.log(`    ✓ 详细统计(${period})`)
  }

  // 4. 仓位历史
  const historyItems = positionHistory.map(item => ({
    source: 'binance',
    source_trader_id: traderId,
    ...item,
    captured_at: capturedAt,
  }))

  if (historyItems.length > 0) {
    const { error } = await supabase.from('trader_position_history').insert(historyItems)
    if (error && !error.message.includes('duplicate')) {
      console.log(`    ✗ 仓位历史: ${error.message}`)
    } else {
      console.log(`    ✓ 仓位历史: ${historyItems.length} 条`)
    }
  }

  // 5. 当前持仓
  const portfolioItems = portfolio.map(item => ({
    source: 'binance',
    source_trader_id: traderId,
    ...item,
    captured_at: capturedAt,
  }))

  if (portfolioItems.length > 0) {
    const { error } = await supabase.from('trader_portfolio').upsert(portfolioItems, {
      onConflict: 'source,source_trader_id,symbol,captured_at'
    })
    if (error) console.log(`    ✗ 当前持仓: ${error.message}`)
    else console.log(`    ✓ 当前持仓: ${portfolioItems.length} 条`)
  }
}

// 主函数
async function main() {
  console.log('🎭 插入模拟数据脚本')
  console.log('====================')
  console.log('注意: 这是模拟数据，仅用于测试 UI 显示效果\n')

  // 检查表是否存在
  console.log('检查数据库表...')
  const tables = ['trader_asset_breakdown', 'trader_equity_curve', 'trader_stats_detail', 'trader_portfolio', 'trader_position_history']
  for (const table of tables) {
    const { error } = await supabase.from(table).select('id').limit(1)
    if (error && (error.code === '42P01' || error.message.includes('does not exist'))) {
      console.log(`  ❌ ${table} 不存在 - 请先运行数据库迁移`)
      console.log('\n请在 Supabase Dashboard 中运行:')
      console.log('  supabase/migrations/00002_binance_trader_details.sql')
      process.exit(1)
    }
    console.log(`  ✓ ${table}`)
  }

  console.log('\n获取交易员...')
  const traders = await getTopTraders(10)
  console.log(`找到 ${traders.length} 名交易员\n`)

  if (traders.length === 0) {
    console.log('没有找到交易员数据')
    process.exit(1)
  }

  console.log('插入模拟数据...\n')
  for (const trader of traders) {
    const mockData = generateMockData(trader.source_trader_id)
    await insertMockData(mockData)
    console.log('')
  }

  console.log('✅ 完成！刷新交易员主页查看效果。')
}

main().catch(console.error)
