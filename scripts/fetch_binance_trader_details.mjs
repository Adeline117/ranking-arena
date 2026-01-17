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

const DETAIL_URL_TEMPLATE = 'https://www.binance.com/en/copy-trading/lead-detail?encryptedUid='

// 时间段配置
const PERIODS = ['7D', '30D', '90D']

/**
 * 获取所有 Binance 交易员列表
 */
async function getAllBinanceTraders() {
  const { data, error } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'binance')
    .eq('is_active', true)
    .limit(200) // 限制数量，避免抓取过多

  if (error) {
    console.error('Error fetching traders:', error)
    return []
  }

  return data || []
}

/**
 * 使用 Puppeteer 抓取交易员详情页数据
 * 优化版：抓取更多详细数据包括资产偏好、收益率曲线、仓位历史等
 */
async function fetchTraderDetails(encryptedUid, browser) {
  const page = await browser.newPage()
  
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  const url = `${DETAIL_URL_TEMPLATE}${encryptedUid}`
  console.log(`  访问: ${url}`)

  // 收集所有捕获的数据
  const collectedData = {
    detail: null,           // 基本详情
    performance: {},        // 项目表现（按时间段）
    assetBreakdown: {},     // 资产偏好（按时间段）
    equityCurve: {},        // 收益率曲线（按时间段）
    positionHistory: [],    // 仓位历史记录
  }

  // 监听网络请求，捕获详情页 API 调用
  page.on('response', async (response) => {
    const responseUrl = response.url()
    
    try {
      // 1. 捕获基本详情
      if (responseUrl.includes('/bapi/futures/v1/friendly/future/copy-trade/lead-detail') ||
          responseUrl.includes('/bapi/futures/v2/public/future/copyTrade/lead-portfolio/detail')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          collectedData.detail = data.data
          console.log(`    ✓ 捕获到基本详情`)
        }
      }
      
      // 2. 捕获项目表现数据（包括夏普比率、胜率等）
      if (responseUrl.includes('/bapi/futures/v1/friendly/future/copy-trade/lead-performance') ||
          responseUrl.includes('/bapi/futures/v2/public/future/copyTrade/lead-portfolio/performance')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          // 从 URL 参数中提取时间段
          const urlParams = new URL(responseUrl).searchParams
          const period = urlParams.get('period') || urlParams.get('timeRange') || '90D'
          const normalizedPeriod = normalizePeriod(period)
          collectedData.performance[normalizedPeriod] = data.data
          console.log(`    ✓ 捕获到项目表现 (${normalizedPeriod})`)
        }
      }
      
      // 3. 捕获资产偏好/持仓分布
      if (responseUrl.includes('/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio') ||
          responseUrl.includes('/bapi/futures/v2/public/future/copyTrade/lead-portfolio/symbol-preference') ||
          responseUrl.includes('symbol-preference') ||
          responseUrl.includes('asset-preference')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          const urlParams = new URL(responseUrl).searchParams
          const period = urlParams.get('period') || urlParams.get('timeRange') || '90D'
          const normalizedPeriod = normalizePeriod(period)
          collectedData.assetBreakdown[normalizedPeriod] = data.data
          console.log(`    ✓ 捕获到资产偏好 (${normalizedPeriod})`)
        }
      }
      
      // 4. 捕获收益率曲线数据
      if (responseUrl.includes('/bapi/futures/v1/friendly/future/copy-trade/lead-chart') ||
          responseUrl.includes('/bapi/futures/v2/public/future/copyTrade/lead-portfolio/pnl-chart') ||
          responseUrl.includes('pnl-chart') ||
          responseUrl.includes('roi-chart') ||
          responseUrl.includes('equity-curve')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          const urlParams = new URL(responseUrl).searchParams
          const period = urlParams.get('period') || urlParams.get('timeRange') || '90D'
          const normalizedPeriod = normalizePeriod(period)
          collectedData.equityCurve[normalizedPeriod] = data.data
          console.log(`    ✓ 捕获到收益率曲线 (${normalizedPeriod})`)
        }
      }
      
      // 5. 捕获仓位历史记录
      if (responseUrl.includes('/bapi/futures/v1/friendly/future/copy-trade/lead-position-history') ||
          responseUrl.includes('/bapi/futures/v2/public/future/copyTrade/lead-portfolio/position-history') ||
          responseUrl.includes('position-history')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          const positions = Array.isArray(data.data) ? data.data : (data.data.list || data.data.positions || [])
          collectedData.positionHistory.push(...positions)
          console.log(`    ✓ 捕获到仓位历史 (${positions.length} 条)`)
        }
      }
      
    } catch (e) {
      // 忽略 JSON 解析错误
    }
  })

  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    })

    // 等待页面加载和初始 API 调用
    await new Promise(resolve => setTimeout(resolve, 3000))

    // 尝试切换时间段以获取不同时间段的数据
    for (const period of PERIODS) {
      try {
        // 尝试点击时间段选择器
        const periodSelectors = [
          `button:has-text("${period}")`,
          `[data-period="${period}"]`,
          `.period-selector button:nth-child(${PERIODS.indexOf(period) + 1})`,
          `//button[contains(text(), "${period}")]`,
        ]
        
        for (const selector of periodSelectors) {
          try {
            const element = await page.$(selector)
            if (element) {
              await element.click()
              await new Promise(resolve => setTimeout(resolve, 1500))
              break
            }
          } catch {
            // 继续尝试下一个选择器
          }
        }
      } catch (e) {
        // 忽略点击错误
      }
    }

    // 尝试获取更多仓位历史（滚动加载或点击"加载更多"）
    try {
      // 点击"仓位历史记录" tab
      const historyTabSelectors = [
        'button:has-text("仓位历史记录")',
        'button:has-text("Position History")',
        '[role="tab"]:nth-child(2)',
      ]
      
      for (const selector of historyTabSelectors) {
        try {
          const element = await page.$(selector)
          if (element) {
            await element.click()
            await new Promise(resolve => setTimeout(resolve, 2000))
            break
          }
        } catch {
          // 继续尝试
        }
      }
    } catch (e) {
      // 忽略
    }

    // 最后等待确保所有数据加载完成
    await new Promise(resolve => setTimeout(resolve, 2000))

  } catch (error) {
    console.error(`    ✗ 访问失败: ${error.message}`)
  } finally {
    await page.close()
  }

  return collectedData
}

/**
 * 标准化时间段字符串
 */
function normalizePeriod(period) {
  const normalized = String(period).toUpperCase().replace(/\s+/g, '')
  if (normalized.includes('7') || normalized.includes('WEEK')) return '7D'
  if (normalized.includes('30') || normalized.includes('MONTH')) return '30D'
  if (normalized.includes('90') || normalized.includes('3MONTH')) return '90D'
  return '90D' // 默认
}

/**
 * 解析详情数据并存储
 */
async function parseAndStoreDetails(encryptedUid, collectedData, capturedAt) {
  if (!collectedData) {
    return
  }

  try {
    const detailData = collectedData.detail || {}
    
    // ==========================================
    // 1. 存储资产偏好数据（按时间段）
    // ==========================================
    for (const period of PERIODS) {
      // 不再使用回退逻辑，确保每个周期有独立的数据
      const assetData = collectedData.assetBreakdown[period]
      
      if (!assetData) {
        console.log(`    ⚠ 资产偏好(${period}) 无数据，跳过`)
        continue
      }
      
      const assetList = Array.isArray(assetData) ? assetData : (assetData.list || assetData.symbols || [])
      
      if (assetList.length > 0) {
        const assetItems = assetList.map((item) => ({
          source: 'binance',
          source_trader_id: encryptedUid,
          period: period,
          symbol: item.symbol || item.asset || item.coin || '',
          weight_pct: parseFloat(item.weightPct || item.weight || item.ratio || item.percentage || 0),
          captured_at: capturedAt,
        })).filter(item => item.symbol && item.weight_pct > 0)

        if (assetItems.length > 0) {
          const { error } = await supabase
            .from('trader_asset_breakdown')
            .upsert(assetItems, { onConflict: 'source,source_trader_id,period,symbol,captured_at' })

          if (error) {
            console.error(`    ✗ 存储资产偏好(${period})失败: ${error.message}`)
          } else {
            console.log(`    ✓ 存储资产偏好(${period}): ${assetItems.length} 条`)
          }
        }
      }
    }

    // ==========================================
    // 2. 存储收益率曲线数据（按时间段）
    // ==========================================
    for (const period of PERIODS) {
      const curveData = collectedData.equityCurve[period] || []
      const curveList = Array.isArray(curveData) ? curveData : (curveData.list || curveData.dataPoints || [])
      
      if (curveList.length > 0) {
        const curveItems = curveList.map((item) => {
          // 解析日期
          let dataDate
          if (item.date) {
            dataDate = item.date
          } else if (item.time || item.timestamp) {
            const ts = item.time || item.timestamp
            dataDate = new Date(typeof ts === 'number' ? ts : parseInt(ts)).toISOString().split('T')[0]
          } else {
            return null
          }
          
          return {
            source: 'binance',
            source_trader_id: encryptedUid,
            period: period,
            data_date: dataDate,
            roi_pct: parseFloat(item.roi || item.roiPct || item.value || 0),
            pnl_usd: parseFloat(item.pnl || item.pnlUsd || item.profit || 0),
            captured_at: capturedAt,
          }
        }).filter(item => item !== null)

        if (curveItems.length > 0) {
          const { error } = await supabase
            .from('trader_equity_curve')
            .upsert(curveItems, { onConflict: 'source,source_trader_id,period,data_date' })

          if (error) {
            console.error(`    ✗ 存储收益率曲线(${period})失败: ${error.message}`)
          } else {
            console.log(`    ✓ 存储收益率曲线(${period}): ${curveItems.length} 条`)
          }
        }
      }
    }

    // ==========================================
    // 3. 存储仓位历史记录
    // ==========================================
    const positionHistory = collectedData.positionHistory || []
    if (positionHistory.length > 0) {
      const positionItems = positionHistory.map((item) => {
        // 解析方向
        let direction = 'long'
        if (item.direction) {
          direction = item.direction.toLowerCase().includes('short') ? 'short' : 'long'
        } else if (item.side) {
          direction = item.side.toLowerCase().includes('sell') || item.side.toLowerCase().includes('short') ? 'short' : 'long'
        }
        
        // 解析时间
        const openTime = item.openTime || item.entryTime || item.createTime
        const closeTime = item.closeTime || item.exitTime || item.updateTime
        
        // 解析状态
        let status = 'closed'
        if (item.status) {
          status = item.status.toLowerCase().includes('partial') ? 'partial' : 'closed'
        } else if (item.closedSize && item.maxPositionSize && 
                   parseFloat(item.closedSize) < parseFloat(item.maxPositionSize)) {
          status = 'partial'
        }
        
        return {
          source: 'binance',
          source_trader_id: encryptedUid,
          symbol: item.symbol || item.pair || '',
          direction: direction,
          position_type: item.positionType || item.type || 'perpetual',
          margin_mode: item.marginMode || item.marginType || 'cross',
          open_time: openTime ? new Date(typeof openTime === 'number' ? openTime : parseInt(openTime)).toISOString() : null,
          close_time: closeTime ? new Date(typeof closeTime === 'number' ? closeTime : parseInt(closeTime)).toISOString() : null,
          entry_price: parseFloat(item.entryPrice || item.openPrice || item.avgEntryPrice || 0),
          exit_price: parseFloat(item.exitPrice || item.closePrice || item.avgExitPrice || 0),
          max_position_size: parseFloat(item.maxPositionSize || item.maxSize || item.qty || 0),
          closed_size: parseFloat(item.closedSize || item.closedQty || item.filledQty || 0),
          pnl_usd: parseFloat(item.pnl || item.realizedPnl || item.profit || 0),
          pnl_pct: parseFloat(item.pnlPct || item.roePct || item.roe || 0),
          status: status,
          captured_at: capturedAt,
        }
      }).filter(item => item.symbol && item.open_time)

      if (positionItems.length > 0) {
        const { error } = await supabase
          .from('trader_position_history')
          .upsert(positionItems, { onConflict: 'source,source_trader_id,symbol,open_time' })

        if (error) {
          console.error(`    ✗ 存储仓位历史失败: ${error.message}`)
        } else {
          console.log(`    ✓ 存储仓位历史: ${positionItems.length} 条`)
        }
      }
    }

    // ==========================================
    // 4. 存储项目表现详细数据（包括夏普比率等）
    // ==========================================
    for (const period of PERIODS) {
      // 不再使用回退逻辑，确保每个周期有独立的数据
      const perfData = collectedData.performance[period]
      
      if (!perfData || Object.keys(perfData).length === 0) {
        console.log(`    ⚠ 周期 ${period} 无数据，跳过`)
        continue
      }
      
      if (perfData && Object.keys(perfData).length > 0) {
        const statsItem = {
          source: 'binance',
          source_trader_id: encryptedUid,
          period: period,
          // ROI 数据
          roi_7d: period === '7D' ? parseFloat(perfData.roi || perfData.roiPct || 0) : null,
          roi_30d: period === '30D' ? parseFloat(perfData.roi || perfData.roiPct || 0) : null,
          roi_90d: period === '90D' ? parseFloat(perfData.roi || perfData.roiPct || 0) : null,
          // 交易统计
          total_trades: parseInt(perfData.totalTrades || perfData.tradeCount || perfData.totalPositions || 0),
          profitable_trades_pct: parseFloat(perfData.winRate || perfData.profitablePct || perfData.winRatio || 0),
          avg_holding_time_hours: parseFloat(perfData.avgHoldingTime || perfData.avgHoldTime || 0),
          avg_profit: parseFloat(perfData.avgProfit || perfData.avgWin || 0),
          avg_loss: parseFloat(perfData.avgLoss || 0),
          // 风险指标
          sharpe_ratio: parseFloat(perfData.sharpeRatio || perfData.sharpe || 0),
          max_drawdown: parseFloat(perfData.maxDrawdown || perfData.mdd || 0),
          // 跟单数据
          copiers_count: parseInt(perfData.copiersCount || perfData.copiers || perfData.followerCount || 0),
          copiers_pnl: parseFloat(perfData.copiersPnl || perfData.followerPnl || perfData.copierProfit || 0),
          aum: parseFloat(perfData.aum || perfData.totalAssets || 0),
          // 获胜仓位
          winning_positions: parseInt(perfData.winningPositions || perfData.profitablePositions || perfData.winCount || 0),
          total_positions: parseInt(perfData.totalPositions || perfData.positionCount || 0),
          captured_at: capturedAt,
        }

        // 移除 null 值
        Object.keys(statsItem).forEach(key => {
          if (statsItem[key] === null || statsItem[key] === 0 || Number.isNaN(statsItem[key])) {
            if (!['source', 'source_trader_id', 'period', 'captured_at'].includes(key)) {
              delete statsItem[key]
            }
          }
        })

        if (Object.keys(statsItem).length > 4) { // 至少有一些有效数据
          const { error } = await supabase
            .from('trader_stats_detail')
            .upsert(statsItem, { onConflict: 'source,source_trader_id,captured_at' })

          if (error) {
            console.error(`    ✗ 存储项目表现(${period})失败: ${error.message}`)
          } else {
            console.log(`    ✓ 存储项目表现(${period})`)
          }
        }
      }
    }

    // ==========================================
    // 5. 存储原有的持仓数据（trader_portfolio）
    // ==========================================
    const portfolioData = detailData.portfolio || detailData.positions || detailData.currentPositions || []
    const portfolioList = Array.isArray(portfolioData) ? portfolioData : (portfolioData.list || [])
    
    if (portfolioList.length > 0) {
      const portfolioItems = portfolioList.map((item) => ({
        source: 'binance',
        source_trader_id: encryptedUid,
        symbol: item.symbol || item.market || '',
        direction: (item.direction || item.side || 'long').toLowerCase().includes('short') ? 'short' : 'long',
        invested_pct: parseFloat(item.investedPct || item.invested || item.weight || 0),
        entry_price: parseFloat(item.entryPrice || item.price || 0),
        current_price: parseFloat(item.currentPrice || item.marketPrice || 0),
        pnl: parseFloat(item.pnl || item.profit || item.unrealizedPnl || 0),
        holding_time_days: parseInt(item.holdingTimeDays || item.holdingTime || 0),
        captured_at: capturedAt,
      })).filter(item => item.symbol)

      if (portfolioItems.length > 0) {
        const { error } = await supabase
          .from('trader_portfolio')
          .upsert(portfolioItems, { onConflict: 'source,source_trader_id,symbol,captured_at' })

        if (error) {
          console.error(`    ✗ 存储当前持仓失败: ${error.message}`)
        } else {
          console.log(`    ✓ 存储当前持仓: ${portfolioItems.length} 条`)
        }
      }
    }

    // ==========================================
    // 6. 存储常用交易币种（trader_frequently_traded）
    // ==========================================
    const frequentlyTraded = detailData.frequentlyTraded || detailData.topSymbols || detailData.frequentSymbols || []
    const frequentlyList = Array.isArray(frequentlyTraded) ? frequentlyTraded : (frequentlyTraded.list || [])
    
    if (frequentlyList.length > 0) {
      const frequentlyTradedItems = frequentlyList.map((item) => ({
        source: 'binance',
        source_trader_id: encryptedUid,
        symbol: item.symbol || item.market || '',
        weight_pct: parseFloat(item.weightPct || item.weight || item.ratio || 0),
        trade_count: parseInt(item.tradeCount || item.count || 0),
        avg_profit: parseFloat(item.avgProfit || item.avgWin || 0),
        avg_loss: parseFloat(item.avgLoss || 0),
        profitable_pct: parseFloat(item.profitablePct || item.winRate || 0),
        captured_at: capturedAt,
      })).filter(item => item.symbol)

      if (frequentlyTradedItems.length > 0) {
        const { error } = await supabase
          .from('trader_frequently_traded')
          .upsert(frequentlyTradedItems, { onConflict: 'source,source_trader_id,symbol,captured_at' })

        if (error) {
          console.error(`    ✗ 存储常用交易币种失败: ${error.message}`)
        } else {
          console.log(`    ✓ 存储常用交易币种: ${frequentlyTradedItems.length} 条`)
        }
      }
    }

    // ==========================================
    // 7. 存储月度表现数据
    // ==========================================
    const monthlyData = detailData.monthlyPerformance || detailData.monthlyRoi || []
    const monthlyList = Array.isArray(monthlyData) ? monthlyData : (monthlyData.list || [])
    
    if (monthlyList.length > 0) {
      const monthlyItems = monthlyList.map((item) => {
        let year, month
        if (item.year && item.month) {
          year = item.year
          month = item.month
        } else if (item.date || item.time) {
          const date = new Date(item.date || item.time)
          year = date.getFullYear()
          month = date.getMonth() + 1
        } else {
          return null
        }
        
        return {
          source: 'binance',
          source_trader_id: encryptedUid,
          year: year,
          month: month,
          roi: parseFloat(item.roi || item.value || item.roiPct || 0),
          pnl: parseFloat(item.pnl || item.profit || 0),
          captured_at: capturedAt,
        }
      }).filter(item => item !== null)

      if (monthlyItems.length > 0) {
        const { error } = await supabase
          .from('trader_monthly_performance')
          .upsert(monthlyItems, { onConflict: 'source,source_trader_id,year,month' })

        if (error) {
          console.error(`    ✗ 存储月度表现失败: ${error.message}`)
        } else {
          console.log(`    ✓ 存储月度表现: ${monthlyItems.length} 条`)
        }
      }
    }

  } catch (error) {
    console.error(`    ✗ 解析数据失败: ${error.message}`)
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    console.log('=== Binance 交易员详情页数据抓取（优化版） ===')
    console.log('抓取内容: 资产偏好、收益率曲线、仓位历史、项目表现等')
    console.log('')

    // 获取所有交易员
    console.log('获取交易员列表...')
    const traders = await getAllBinanceTraders()
    console.log(`找到 ${traders.length} 个交易员`)
    console.log('')

    if (traders.length === 0) {
      console.log('没有交易员可抓取')
      return
    }

    // 启动浏览器
    console.log('启动浏览器...')
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    const capturedAt = new Date().toISOString()
    console.log(`统一 captured_at: ${capturedAt}`)
    console.log('')

    let successCount = 0
    let failCount = 0

    // 串行抓取每个交易员的详情（避免请求过快）
    for (let i = 0; i < traders.length; i++) {
      const trader = traders[i]
      console.log(`[${i + 1}/${traders.length}] ${trader.handle || trader.source_trader_id}`)

      try {
        const collectedData = await fetchTraderDetails(trader.source_trader_id, browser)

        if (collectedData && (collectedData.detail || 
            Object.keys(collectedData.performance).length > 0 ||
            Object.keys(collectedData.assetBreakdown).length > 0 ||
            collectedData.positionHistory.length > 0)) {
          await parseAndStoreDetails(trader.source_trader_id, collectedData, capturedAt)
          successCount++
        } else {
          console.log(`    ⚠️ 未获取到数据`)
          failCount++
        }

        // 延迟避免请求过快（每个请求间隔 3 秒）
        if (i < traders.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 3000))
        }

      } catch (error) {
        console.error(`    ✗ 抓取失败: ${error.message}`)
        failCount++
      }
    }

    await browser.close()

    console.log('')
    console.log(`✅ 完成！成功: ${successCount}, 失败: ${failCount}`)
    console.log(`✅ 统一 captured_at: ${capturedAt}`)

  } catch (error) {
    console.error('执行失败:', error)
    process.exit(1)
  }
}

main()
