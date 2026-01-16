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
 */
async function fetchTraderDetails(encryptedUid, browser) {
  const page = await browser.newPage()
  
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  const url = `${DETAIL_URL_TEMPLATE}${encryptedUid}`
  console.log(`  访问: ${url}`)

  let detailData = null

  // 监听网络请求，捕获详情页 API 调用
  page.on('response', async (response) => {
    const responseUrl = response.url()
    
    // 捕获详情页相关的 API 调用
    if (responseUrl.includes('/bapi/futures/v1/friendly/future/copy-trade/lead-detail') ||
        responseUrl.includes('/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio') ||
        responseUrl.includes('/bapi/futures/v1/friendly/future/copy-trade/lead-performance')) {
      try {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          detailData = data.data
          console.log(`    ✓ 捕获到详情数据`)
        }
      } catch (e) {
        // 忽略 JSON 解析错误
      }
    }
  })

  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    })

    // 等待页面加载和 API 调用
    await new Promise(resolve => setTimeout(resolve, 5000))

    // 如果通过监听没有获取到数据，尝试直接从页面提取
    if (!detailData) {
      try {
        // 尝试从页面中提取数据（如果 API 调用失败）
        detailData = await page.evaluate(() => {
          // 查找页面中的数据（如果 API 调用被拦截，可以尝试从 DOM 提取）
          // 这需要根据实际页面结构调整
          return null
        })
      } catch (e) {
        // 忽略
      }
    }

  } catch (error) {
    console.error(`    ✗ 访问失败: ${error.message}`)
  } finally {
    await page.close()
  }

  return detailData
}

/**
 * 解析详情数据并存储
 */
async function parseAndStoreDetails(encryptedUid, detailData, capturedAt) {
  if (!detailData) {
    return
  }

  try {
    // 解析持仓数据
    const portfolioData = detailData.portfolio || detailData.positions || []
    if (portfolioData.length > 0) {
      const portfolioItems = portfolioData.map((item) => ({
        source: 'binance',
        source_trader_id: encryptedUid,
        symbol: item.symbol || item.market || '',
        direction: item.direction || item.side || 'long',
        invested_pct: item.investedPct || item.invested || 0,
        entry_price: item.entryPrice || item.price || 0,
        current_price: item.currentPrice || item.marketPrice || 0,
        pnl: item.pnl || item.profit || 0,
        holding_time_days: item.holdingTimeDays || item.holdingTime || 0,
        captured_at: capturedAt,
      }))

      // 使用 upsert 存储持仓数据
      const { error } = await supabase
        .from('trader_portfolio')
        .upsert(portfolioItems, { onConflict: 'source,source_trader_id,symbol,captured_at' })

      if (error) {
        console.error(`    ✗ 存储持仓数据失败: ${error.message}`)
      } else {
        console.log(`    ✓ 存储持仓数据: ${portfolioItems.length} 条`)
      }
    }

    // 解析月度表现数据
    const monthlyData = detailData.monthlyPerformance || detailData.monthlyRoi || []
    if (monthlyData.length > 0) {
      const monthlyItems = monthlyData.map((item) => {
        const date = new Date(item.year || item.month || item.date)
        return {
          source: 'binance',
          source_trader_id: encryptedUid,
          year: date.getFullYear(),
          month: date.getMonth() + 1,
          roi: item.roi || item.value || 0,
          pnl: item.pnl || 0,
          captured_at: capturedAt,
        }
      })

      const { error } = await supabase
        .from('trader_monthly_performance')
        .upsert(monthlyItems, { onConflict: 'source,source_trader_id,year,month,captured_at' })

      if (error) {
        console.error(`    ✗ 存储月度表现失败: ${error.message}`)
      } else {
        console.log(`    ✓ 存储月度表现: ${monthlyItems.length} 条`)
      }
    }

    // 解析年度表现数据
    const yearlyData = detailData.yearlyPerformance || detailData.yearlyRoi || []
    if (yearlyData.length > 0) {
      const yearlyItems = yearlyData.map((item) => ({
        source: 'binance',
        source_trader_id: encryptedUid,
        year: item.year || new Date(item.date).getFullYear(),
        roi: item.roi || item.value || 0,
        pnl: item.pnl || 0,
        captured_at: capturedAt,
      }))

      const { error } = await supabase
        .from('trader_yearly_performance')
        .upsert(yearlyItems, { onConflict: 'source,source_trader_id,year,captured_at' })

      if (error) {
        console.error(`    ✗ 存储年度表现失败: ${error.message}`)
      } else {
        console.log(`    ✓ 存储年度表现: ${yearlyItems.length} 条`)
      }
    }

    // 解析常用交易币种
    const frequentlyTraded = detailData.frequentlyTraded || detailData.topSymbols || []
    if (frequentlyTraded.length > 0) {
      const frequentlyTradedItems = frequentlyTraded.map((item) => ({
        source: 'binance',
        source_trader_id: encryptedUid,
        symbol: item.symbol || item.market || '',
        weight_pct: item.weightPct || item.weight || 0,
        trade_count: item.tradeCount || item.count || 0,
        avg_profit: item.avgProfit || 0,
        avg_loss: item.avgLoss || 0,
        profitable_pct: item.profitablePct || item.winRate || 0,
        captured_at: capturedAt,
      }))

      const { error } = await supabase
        .from('trader_frequently_traded')
        .upsert(frequentlyTradedItems, { onConflict: 'source,source_trader_id,symbol,captured_at' })

      if (error) {
        console.error(`    ✗ 存储常用交易币种失败: ${error.message}`)
      } else {
        console.log(`    ✓ 存储常用交易币种: ${frequentlyTradedItems.length} 条`)
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
    console.log('=== Binance 交易员详情页数据抓取 ===')
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
        const detailData = await fetchTraderDetails(trader.source_trader_id, browser)

        if (detailData) {
          await parseAndStoreDetails(trader.source_trader_id, detailData, capturedAt)
          successCount++
        } else {
          console.log(`    ⚠️ 未获取到数据`)
          failCount++
        }

        // 延迟避免请求过快（每个请求间隔 2 秒）
        if (i < traders.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000))
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



