/**
 * 一键设置脚本：创建数据库表并抓取数据
 * 用法: node scripts/setup_and_fetch_details.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DETAIL_URL_TEMPLATE = 'https://www.binance.com/en/copy-trading/lead-detail?encryptedUid='
const PERIODS = ['7D', '30D', '90D']

// ============================================================
// 步骤 1: 创建数据库表
// ============================================================
async function createTables() {
  console.log('\n📦 步骤 1/3: 创建数据库表...')
  
  // 创建 trader_asset_breakdown 表
  const { error: error1 } = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS trader_asset_breakdown (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        source VARCHAR(50) NOT NULL,
        source_trader_id VARCHAR(255) NOT NULL,
        period VARCHAR(10) NOT NULL,
        symbol VARCHAR(50) NOT NULL,
        weight_pct DECIMAL(10, 4) NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_trader_asset_breakdown_lookup 
        ON trader_asset_breakdown(source, source_trader_id, period);
    `
  }).catch(() => null)
  
  // 尝试直接创建表（如果 rpc 不可用）
  console.log('  - 检查 trader_asset_breakdown 表...')
  const { error: checkAsset } = await supabase.from('trader_asset_breakdown').select('id').limit(1)
  if (checkAsset?.message?.includes('does not exist') || checkAsset?.code === '42P01') {
    console.log('    ⚠️  表不存在，需要在 Supabase 控制台手动创建')
    console.log('    请运行: supabase/migrations/00002_binance_trader_details.sql')
    return false
  }
  console.log('    ✓ trader_asset_breakdown 表已存在或已创建')

  console.log('  - 检查 trader_equity_curve 表...')
  const { error: checkCurve } = await supabase.from('trader_equity_curve').select('id').limit(1)
  if (checkCurve?.message?.includes('does not exist') || checkCurve?.code === '42P01') {
    console.log('    ⚠️  表不存在')
    return false
  }
  console.log('    ✓ trader_equity_curve 表已存在或已创建')

  console.log('  - 检查 trader_position_history 表...')
  const { error: checkHistory } = await supabase.from('trader_position_history').select('id').limit(1)
  if (checkHistory?.message?.includes('does not exist') || checkHistory?.code === '42P01') {
    console.log('    ⚠️  表不存在')
    return false
  }
  console.log('    ✓ trader_position_history 表已存在或已创建')

  console.log('  - 检查 trader_stats_detail 表...')
  const { error: checkStats } = await supabase.from('trader_stats_detail').select('id').limit(1)
  if (checkStats?.message?.includes('does not exist') || checkStats?.code === '42P01') {
    console.log('    ⚠️  表不存在')
    return false
  }
  console.log('    ✓ trader_stats_detail 表已存在或已创建')

  console.log('  - 检查 trader_portfolio 表...')
  const { error: checkPortfolio } = await supabase.from('trader_portfolio').select('id').limit(1)
  if (checkPortfolio?.message?.includes('does not exist') || checkPortfolio?.code === '42P01') {
    console.log('    ⚠️  表不存在')
    return false
  }
  console.log('    ✓ trader_portfolio 表已存在或已创建')

  return true
}

// ============================================================
// 步骤 2: 获取交易员列表
// ============================================================
async function getTopTraders(limit = 5) {
  console.log(`\n📋 步骤 2/3: 获取前 ${limit} 名交易员...`)
  
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, source')
    .eq('source', 'binance')
    .order('roi', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('  ✗ 获取交易员失败:', error.message)
    return []
  }

  // 去重
  const uniqueTraders = [...new Map(data.map(t => [t.source_trader_id, t])).values()]
  console.log(`  ✓ 获取到 ${uniqueTraders.length} 名交易员`)
  return uniqueTraders
}

// ============================================================
// 步骤 3: 抓取并存储详情数据
// ============================================================
async function fetchAndStoreDetails(traders) {
  console.log(`\n🔍 步骤 3/3: 抓取交易员详情...`)
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const capturedAt = new Date().toISOString()

  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i]
    console.log(`\n  [${i + 1}/${traders.length}] 处理: ${trader.source_trader_id}`)
    
    try {
      const data = await fetchTraderDetails(trader.source_trader_id, browser)
      await storeTraderDetails(trader.source_trader_id, data, capturedAt)
    } catch (error) {
      console.error(`    ✗ 抓取失败: ${error.message}`)
    }
  }

  await browser.close()
  console.log('\n✅ 数据抓取完成！')
}

/**
 * 使用 Puppeteer 抓取交易员详情
 */
async function fetchTraderDetails(encryptedUid, browser) {
  const page = await browser.newPage()
  
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  const url = `${DETAIL_URL_TEMPLATE}${encryptedUid}`
  console.log(`    访问: ${url}`)

  const collectedData = {
    detail: null,
    performance: {},
    assetBreakdown: {},
    equityCurve: {},
    positionHistory: [],
  }

  // 监听 API 响应
  page.on('response', async (response) => {
    const responseUrl = response.url()
    
    try {
      // 基本详情
      if (responseUrl.includes('lead-detail') || responseUrl.includes('lead-portfolio/detail')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          collectedData.detail = data.data
          console.log(`    ✓ 捕获基本详情`)
        }
      }
      
      // 项目表现
      if (responseUrl.includes('lead-performance') || responseUrl.includes('performance')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          const urlParams = new URL(responseUrl).searchParams
          const period = normalizePeriod(urlParams.get('period') || '90D')
          collectedData.performance[period] = data.data
          console.log(`    ✓ 捕获项目表现 (${period})`)
        }
      }
      
      // 资产偏好
      if (responseUrl.includes('symbol-preference') || responseUrl.includes('asset-preference')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          const urlParams = new URL(responseUrl).searchParams
          const period = normalizePeriod(urlParams.get('period') || '90D')
          collectedData.assetBreakdown[period] = data.data
          console.log(`    ✓ 捕获资产偏好 (${period})`)
        }
      }
      
      // 收益率曲线
      if (responseUrl.includes('pnl-chart') || responseUrl.includes('roi-chart')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          const urlParams = new URL(responseUrl).searchParams
          const period = normalizePeriod(urlParams.get('period') || '90D')
          collectedData.equityCurve[period] = data.data
          console.log(`    ✓ 捕获收益率曲线 (${period})`)
        }
      }
      
      // 仓位历史
      if (responseUrl.includes('position-history')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          const positions = Array.isArray(data.data) ? data.data : (data.data.list || [])
          collectedData.positionHistory.push(...positions)
          console.log(`    ✓ 捕获仓位历史 (${positions.length} 条)`)
        }
      }
    } catch (e) {
      // 忽略
    }
  })

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(resolve => setTimeout(resolve, 5000))
    
    // 尝试切换时间段
    for (const period of PERIODS) {
      try {
        const btn = await page.$(`button:has-text("${period}")`)
        if (btn) {
          await btn.click()
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      } catch {}
    }
    
  } catch (error) {
    console.error(`    ✗ 访问失败: ${error.message}`)
  } finally {
    await page.close()
  }

  return collectedData
}

/**
 * 存储交易员详情
 */
async function storeTraderDetails(encryptedUid, data, capturedAt) {
  if (!data) return

  // 存储资产偏好
  for (const period of PERIODS) {
    const assetData = data.assetBreakdown[period] || data.detail?.symbolPreference || []
    const assetList = Array.isArray(assetData) ? assetData : (assetData.list || [])
    
    if (assetList.length > 0) {
      const items = assetList.slice(0, 10).map(item => ({
        source: 'binance',
        source_trader_id: encryptedUid,
        period,
        symbol: item.symbol || item.asset || '',
        weight_pct: parseFloat(item.weightPct || item.weight || item.ratio || 0),
        captured_at: capturedAt,
      })).filter(i => i.symbol && i.weight_pct > 0)

      if (items.length > 0) {
        const { error } = await supabase.from('trader_asset_breakdown').upsert(items, {
          onConflict: 'source,source_trader_id,period,symbol,captured_at'
        })
        if (!error) console.log(`    ✓ 存储资产偏好(${period}): ${items.length} 条`)
        else console.log(`    ✗ 存储失败: ${error.message}`)
      }
    }
  }

  // 存储收益率曲线
  for (const period of PERIODS) {
    const curveData = data.equityCurve[period] || []
    const curveList = Array.isArray(curveData) ? curveData : (curveData.list || [])
    
    if (curveList.length > 0) {
      const items = curveList.map(item => {
        let dataDate
        if (item.date) dataDate = item.date
        else if (item.time || item.timestamp) {
          const ts = item.time || item.timestamp
          dataDate = new Date(typeof ts === 'number' ? ts : parseInt(ts)).toISOString().split('T')[0]
        }
        if (!dataDate) return null
        
        return {
          source: 'binance',
          source_trader_id: encryptedUid,
          period,
          data_date: dataDate,
          roi_pct: parseFloat(item.roi || item.roiPct || item.value || 0),
          pnl_usd: parseFloat(item.pnl || item.pnlUsd || 0),
          captured_at: capturedAt,
        }
      }).filter(i => i !== null)

      if (items.length > 0) {
        const { error } = await supabase.from('trader_equity_curve').upsert(items, {
          onConflict: 'source,source_trader_id,period,data_date'
        })
        if (!error) console.log(`    ✓ 存储收益率曲线(${period}): ${items.length} 条`)
      }
    }
  }

  // 存储仓位历史
  if (data.positionHistory.length > 0) {
    const items = data.positionHistory.slice(0, 50).map(item => {
      const direction = (item.direction?.toLowerCase() || item.side?.toLowerCase() || '').includes('short') ? 'short' : 'long'
      const openTime = item.openTime || item.entryTime || item.createTime
      if (!openTime) return null
      
      return {
        source: 'binance',
        source_trader_id: encryptedUid,
        symbol: item.symbol || item.pair || '',
        direction,
        position_type: item.positionType || 'perpetual',
        margin_mode: item.marginMode || 'cross',
        open_time: new Date(typeof openTime === 'number' ? openTime : parseInt(openTime)).toISOString(),
        close_time: item.closeTime ? new Date(typeof item.closeTime === 'number' ? item.closeTime : parseInt(item.closeTime)).toISOString() : null,
        entry_price: parseFloat(item.entryPrice || item.openPrice || 0),
        exit_price: parseFloat(item.exitPrice || item.closePrice || 0),
        max_position_size: parseFloat(item.maxPositionSize || item.qty || 0),
        closed_size: parseFloat(item.closedSize || item.filledQty || 0),
        pnl_usd: parseFloat(item.pnl || item.realizedPnl || 0),
        pnl_pct: parseFloat(item.pnlPct || item.roe || 0),
        status: 'closed',
        captured_at: capturedAt,
      }
    }).filter(i => i !== null && i.symbol)

    if (items.length > 0) {
      const { error } = await supabase.from('trader_position_history').insert(items)
      if (!error) console.log(`    ✓ 存储仓位历史: ${items.length} 条`)
    }
  }

  // 存储详细统计
  for (const period of PERIODS) {
    const perf = data.performance[period] || data.detail || {}
    if (Object.keys(perf).length > 0) {
      const item = {
        source: 'binance',
        source_trader_id: encryptedUid,
        period,
        roi: parseFloat(perf.roi || perf.roiPct || 0),
        total_trades: parseInt(perf.totalTrades || perf.tradeCount || 0),
        profitable_trades_pct: parseFloat(perf.winRate || perf.profitablePct || 0),
        avg_holding_time_hours: parseFloat(perf.avgHoldingTime || 0),
        avg_profit: parseFloat(perf.avgProfit || 0),
        avg_loss: parseFloat(perf.avgLoss || 0),
        sharpe_ratio: parseFloat(perf.sharpeRatio || 0),
        max_drawdown: parseFloat(perf.maxDrawdown || 0),
        copiers_count: parseInt(perf.copierCount || perf.copyersNum || 0),
        copiers_pnl: parseFloat(perf.copierPnl || 0),
        winning_positions: parseInt(perf.profitableTrades || 0),
        total_positions: parseInt(perf.totalTrades || 0),
        captured_at: capturedAt,
      }

      const { error } = await supabase.from('trader_stats_detail').upsert(item, {
        onConflict: 'source,source_trader_id,period,captured_at'
      })
      if (!error) console.log(`    ✓ 存储详细统计(${period})`)
    }
  }
}

function normalizePeriod(period) {
  const p = String(period).toUpperCase()
  if (p.includes('7') || p.includes('WEEK')) return '7D'
  if (p.includes('30') || p.includes('MONTH')) return '30D'
  return '90D'
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  console.log('🚀 Binance 交易员详情数据设置脚本')
  console.log('================================')

  // 步骤 1: 检查/创建表
  const tablesExist = await createTables()
  
  if (!tablesExist) {
    console.log('\n⚠️  请先在 Supabase 控制台运行以下 SQL 文件:')
    console.log('   supabase/migrations/00002_binance_trader_details.sql')
    console.log('\n   或者使用 Supabase CLI:')
    console.log('   npx supabase db push')
    process.exit(1)
  }

  // 步骤 2: 获取交易员
  const traders = await getTopTraders(5)
  
  if (traders.length === 0) {
    console.log('\n⚠️  没有找到 Binance 交易员数据')
    process.exit(1)
  }

  // 步骤 3: 抓取数据
  await fetchAndStoreDetails(traders)
  
  console.log('\n🎉 设置完成！请刷新交易员主页查看数据。')
}

main().catch(console.error)
