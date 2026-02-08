/**
 * Binance Spot Copy Trading 排行榜数据抓取
 * 
 * 通过拦截 API 请求，获取 ROI 排序的数据
 * 
 * 用法: node scripts/import_binance_spot.mjs [7D|30D|90D]
 * 
 * 数据源: https://www.binance.com/zh-CN/copy-trading/spot
 * API: https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list
 */

import { chromium } from 'playwright'
import { validateTraderData, deduplicateTraders, printValidationResult } from './lib/data-validation.mjs'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'binance_spot'
const BASE_URL = 'https://www.binance.com/zh-CN/copy-trading/spot'

const TARGET_COUNT = 2000
const PER_PAGE = 100
const MAX_PAGES = 2

function parseTraderFromApi(item, rank) {
  const traderId = String(item.leadPortfolioId || item.portfolioId || item.encryptedUid || '')
  if (!traderId) return null

  // Binance API 返回的 ROI 已经是百分比形式
  const roi = parseFloat(item.roi ?? 0)

  // winRate 是 0-100 的数值，需要转换为 0-1
  let winRate = parseFloat(item.winRate ?? 0)
  if (winRate > 1) {
    winRate = winRate / 100
  }

  return {
    traderId,
    nickname: item.nickname || item.nickName || item.displayName || null,
    avatar: item.avatarUrl || item.userPhoto || item.avatar || null,
    roi,
    pnl: parseFloat(item.pnl ?? item.profit ?? 0),
    winRate,
    maxDrawdown: parseFloat(item.mdd ?? item.maxDrawdown ?? 0),
    followers: parseInt(item.currentCopyCount ?? item.copierCount ?? item.followerCount ?? 0),
    aum: parseFloat(item.aum ?? item.totalAsset ?? 0),
    rank,
  }
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Binance Spot ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log('URL:', BASE_URL)
  console.log(`目标: ${TARGET_COUNT} 个交易员，最多翻 ${MAX_PAGES} 页`)

  const traders = new Map()

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
  })

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      window.chrome = { runtime: {} }
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
      })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
    })

    const page = await context.newPage()
    
    // 核心改进：拦截 API 请求并修改参数
    let currentPageNum = 1
    await page.route('**/home-page-list', async (route) => {
      const request = route.request()
      const postData = request.postData()
      
      if (postData) {
        try {
          const data = JSON.parse(postData)
          // 修改为目标时间段和 ROI 排序
          data.timeRange = period
          data.dataType = 'ROI'
          data.order = 'DESC'
          data.pageNumber = currentPageNum
          data.pageSize = PER_PAGE
          data.portfolioType = 'ALL'  // 获取所有交易员，不只是推荐的
          
          console.log(`  📡 API 请求: 第 ${data.pageNumber} 页, ${data.timeRange}, 排序: ${data.dataType}`)
          
          await route.continue({
            postData: JSON.stringify(data)
          })
        } catch (e) {
          await route.continue()
        }
      } else {
        await route.continue()
      }
    })

    // 存储 API 响应数据
    const apiResponses = []
    
    // 监听 API 响应
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('home-page-list')) {
        try {
          const json = await response.json()
          if (json.data && (json.code === '000000' || json.success !== false)) {
            const list = json.data?.list || json.data?.data || []
            if (Array.isArray(list) && list.length > 0) {
              console.log(`  ✓ 收到 ${list.length} 条数据`)
              apiResponses.push({ list, pageNum: currentPageNum })
            }
          }
        } catch (e) {
          console.log(`  ⚠ 解析响应失败: ${e.message}`)
        }
      }
    })

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    await sleep(10000)
    
    // 处理第一页数据
    for (const { list, pageNum } of apiResponses) {
      list.forEach((item, idx) => {
        const rank = (pageNum - 1) * PER_PAGE + idx + 1
        const trader = parseTraderFromApi(item, rank)
        if (trader && trader.traderId && !traders.has(trader.traderId)) {
          traders.set(trader.traderId, trader)
          if (traders.size <= 3) {
            console.log(`    #${rank}: ROI ${trader.roi.toFixed(2)}%, 昵称: ${trader.nickname || '未知'}`)
          }
        }
      })
    }
    apiResponses.length = 0
    
    console.log(`\n📄 当前已获取: ${traders.size} 个交易员`)

    // 分页获取更多数据
    while (traders.size < TARGET_COUNT && currentPageNum < MAX_PAGES) {
      currentPageNum++
      console.log(`\n📄 翻页到第 ${currentPageNum} 页...`)
      
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1000)
      
      let pageClicked = false
      
      pageClicked = await page.evaluate((targetPage) => {
        const paginationContainers = document.querySelectorAll('[class*="pagination"], [class*="Pagination"], nav')
        
        for (const container of paginationContainers) {
          const buttons = container.querySelectorAll('button, a, span, li')
          for (const btn of buttons) {
            const text = btn.textContent?.trim()
            if (text === String(targetPage)) {
              btn.click()
              return true
            }
          }
        }
        
        const nextBtns = document.querySelectorAll('[class*="next"], [aria-label*="next"]')
        for (const btn of nextBtns) {
          if (btn.offsetParent !== null) {
            btn.click()
            return true
          }
        }
        
        return false
      }, currentPageNum)
      
      if (pageClicked) {
        console.log(`  ✓ 翻页成功`)
        await sleep(3000)
      } else {
        const pageSelectors = [
          `button:text-is("${currentPageNum}")`,
          `[class*="pagination"] >> text="${currentPageNum}"`,
        ]
        
        for (const selector of pageSelectors) {
          try {
            const element = await page.$(selector)
            if (element && await element.isVisible()) {
              await element.click()
              console.log(`  ✓ 翻页成功`)
              pageClicked = true
              await sleep(3000)
              break
            }
          } catch (e) {}
        }
      }
      
      if (!pageClicked) {
        console.log(`  ⚠ 翻页失败，停止分页`)
        break
      }
      
      // 处理新页数据
      await sleep(2000)
      for (const { list, pageNum } of apiResponses) {
        list.forEach((item, idx) => {
          const rank = (pageNum - 1) * PER_PAGE + idx + 1
          const trader = parseTraderFromApi(item, rank)
          if (trader && trader.traderId && !traders.has(trader.traderId)) {
            traders.set(trader.traderId, trader)
          }
        })
      }
      apiResponses.length = 0
      
      console.log(`  当前已获取: ${traders.size} 个交易员`)
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)

    const screenshotPath = `/tmp/binance_spot_${period}_${Date.now()}.png`
    await page.screenshot({ path: screenshotPath, fullPage: true })
    console.log(`📸 截图保存到: ${screenshotPath}`)

  } finally {
    await browser.close()
  }

  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员到数据库 (${SOURCE} - ${period})...`)
  
  const capturedAt = new Date().toISOString()
  let saved = 0
  let errors = 0

  for (const trader of traders) {
    try {
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: trader.traderId,
        handle: trader.nickname,
        avatar_url: trader.avatar || null,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const normalizedWr = trader.winRate !== null ? (trader.winRate <= 1 ? trader.winRate * 100 : trader.winRate) : null
      const { error } = await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: trader.traderId,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl,
        win_rate: normalizedWr,
        max_drawdown: trader.maxDrawdown,
        followers: trader.followers || 0,
        arena_score: calculateArenaScore(trader.roi, trader.pnl, trader.maxDrawdown, normalizedWr, period).totalScore,
        captured_at: capturedAt,
      })

      if (error) {
        console.log(`    ✗ 保存失败 ${trader.traderId}: ${error.message}`)
        errors++
      } else {
        saved++
      }
    } catch (error) {
      console.log(`    ✗ 异常 ${trader.traderId}: ${error.message}`)
      errors++
    }
  }

  console.log(`  ✓ 保存成功: ${saved}`)
  if (errors > 0) console.log(`  ✗ 保存失败: ${errors}`)

  return { saved, errors }
}

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Binance Spot Copy Trading 数据抓取`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`数据源: ${SOURCE}`)
  console.log(`目标数量: ${TARGET_COUNT} 个交易员/周期`)
  console.log(`========================================`)

  const results = []

  try {
    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 开始抓取 ${period} 排行榜...`)
      console.log(`${'='.repeat(50)}`)
      
      const traders = await fetchLeaderboardData(period)

      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到任何数据，跳过`)
        continue
      }

      const uniqueTraders = deduplicateTraders(traders)
      uniqueTraders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
      uniqueTraders.forEach((t, idx) => t.rank = idx + 1)

      const top100 = uniqueTraders.slice(0, TARGET_COUNT)

      console.log(`\n📋 ${period} TOP 10 (按 ROI 排序):`)
      top100.slice(0, 10).forEach((t, idx) => {
        console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
      })

      const validation = validateTraderData(top100, {}, SOURCE)
      const isValid = printValidationResult(validation, SOURCE)

      if (!isValid) {
        console.log(`\n⚠ ${period} 数据质量验证失败，跳过保存`)
        continue
      }

      const result = await saveTraders(top100, period)
      results.push({ period, count: top100.length, saved: result.saved, topRoi: validation.stats.topRoi })
      
      console.log(`\n✅ ${period} 完成！保存了 ${result.saved} 条数据`)
      
      if (periods.indexOf(period) < periods.length - 1) {
        console.log(`\n⏳ 等待 5 秒后抓取下一个时间段...`)
        await sleep(5000)
      }
    }
    
    const totalElapsed = ((Date.now() - totalStartTime) / 1000).toFixed(1)

    console.log(`\n${'='.repeat(60)}`)
    console.log(`✅ 全部完成！`)
    console.log(`${'='.repeat(60)}`)
    console.log(`📊 抓取结果:`)
    for (const r of results) {
      console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
    }
    console.log(`   总耗时: ${totalElapsed}s`)
    console.log(`   时间: ${new Date().toISOString()}`)
    console.log(`${'='.repeat(60)}`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main()
