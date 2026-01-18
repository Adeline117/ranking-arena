/**
 * Binance Spot Copy Trading 排行榜数据抓取
 * 
 * 和 Futures 一样：选择时间 -> 选择收益率 -> 底下数字选页码
 * 
 * 用法: node scripts/import_binance_spot.mjs [7D|30D|90D]
 * 
 * 数据源: https://www.binance.com/zh-CN/copy-trading/spot
 */

import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'binance_spot'
const BASE_URL = 'https://www.binance.com/zh-CN/copy-trading/spot'

const TARGET_COUNT = 100
const PER_PAGE = 18
const MAX_PAGES = Math.ceil(TARGET_COUNT / PER_PAGE) + 1

const PERIOD_CONFIG = {
  '7D': { tabTexts: ['7天', '7 Days', '7D'], sortText: '收益率' },
  '30D': { tabTexts: ['30天', '30 Days', '30D'], sortText: '收益率' },
  '90D': { tabTexts: ['90天', '90 Days', '90D'], sortText: '收益率' },
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) {
    return arg
  }
  return '90D'
}

function parseTraderFromApi(item, rank) {
  const traderId = String(item.portfolioId || item.encryptedUid || item.leadPortfolioId || '')
  if (!traderId) return null

  let roi = parseFloat(item.roi ?? item.roiPct ?? item.roiRate ?? 0)
  if (roi > 0 && roi < 10) {
    roi = roi * 100
  }

  return {
    traderId,
    nickname: item.nickName || item.nickname || item.displayName || null,
    avatar: item.userPhoto || item.avatar || item.avatarUrl || null,
    roi,
    pnl: parseFloat(item.pnl ?? item.profit ?? item.totalProfit ?? 0),
    winRate: parseFloat(item.winRate ?? item.winRatio ?? 0),
    maxDrawdown: parseFloat(item.mdd ?? item.maxDrawdown ?? 0),
    followers: parseInt(item.copierCount ?? item.followerCount ?? item.followers ?? 0),
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
  const apiResponses = []

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
    const config = PERIOD_CONFIG[period]

    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy-trade') && (url.includes('query-list') || url.includes('list') || url.includes('spot') || url.includes('rank'))) {
        try {
          const json = await response.json()
          if (json.data && (json.code === '000000' || json.success !== false)) {
            const list = json.data?.list || json.data?.data || (Array.isArray(json.data) ? json.data : [])
            if (Array.isArray(list) && list.length > 0) {
              console.log(`  📡 拦截到 API: ${list.length} 条数据`)
              apiResponses.push({ url, list, timestamp: Date.now() })
            }
          }
        } catch (e) {}
      }
    })

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    await sleep(5000)

    // 步骤 1: 点击收益率排序
    console.log('\n🔄 点击收益率排序...')
    const sortClicked = await page.evaluate((sortText) => {
      const elements = document.querySelectorAll('span, div, button, th')
      for (const el of elements) {
        const text = el.textContent?.trim()
        if (text === sortText || text?.includes(sortText)) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0 && rect.top < 500) {
            el.click()
            return true
          }
        }
      }
      return false
    }, config.sortText)
    
    if (sortClicked) {
      console.log(`  ✓ 收益率排序点击成功`)
      await sleep(2000)
    }

    // 步骤 2: 切换时间周期（下拉菜单）
    console.log(`\n🔄 切换到 ${period} 时间周期...`)
    let periodSwitched = false
    
    try {
      await page.evaluate(() => window.scrollTo(0, 0))
      await sleep(1000)
      
      const selectTrigger = page.locator('[class*="bn-select"]:has-text("天")').first()
      
      if (await selectTrigger.count() > 0) {
        console.log(`  找到时间下拉菜单，点击打开...`)
        await selectTrigger.click()
        await sleep(1000)
        
        for (const tabText of config.tabTexts) {
          const option = page.locator(`[class*="bn-select-option"]:has-text("${tabText}")`).first()
          
          if (await option.count() > 0) {
            await option.click()
            console.log(`  ✓ 时间切换成功: "${tabText}"`)
            periodSwitched = true
            await sleep(3000)
            apiResponses.length = 0
            break
          }
        }
      }
      
      if (!periodSwitched) {
        for (const tabText of config.tabTexts) {
          const timeElements = page.locator(`text=${tabText}`).all()
          const elements = await timeElements
          
          for (const el of elements) {
            try {
              const box = await el.boundingBox()
              if (box && box.y < 600 && box.y > 100) {
                await el.click()
                console.log(`  ✓ 时间切换成功（备用方案）: "${tabText}"`)
                periodSwitched = true
                await sleep(3000)
                apiResponses.length = 0
                break
              }
            } catch (e) {}
          }
          if (periodSwitched) break
        }
      }
    } catch (e) {
      console.log(`  ⚠ 切换时间失败: ${e.message}`)
    }
    
    if (!periodSwitched) {
      console.log(`  ⚠ 未找到时间切换按钮，使用默认数据`)
    }

    // 步骤 3: 分页获取数据
    console.log('\n📄 开始分页获取数据...')
    
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      console.log(`\n  === 第 ${pageNum} 页 ===`)
      
      await sleep(2000)
      await page.evaluate(() => window.scrollBy(0, 500))
      await sleep(1000)
      
      // 处理 API 响应
      for (const { list } of apiResponses) {
        list.forEach((item, idx) => {
          const trader = parseTraderFromApi(item, traders.size + idx + 1)
          if (trader && trader.traderId && !traders.has(trader.traderId)) {
            traders.set(trader.traderId, trader)
          }
        })
      }
      
      console.log(`  当前已获取: ${traders.size} 个交易员`)
      
      if (traders.size >= TARGET_COUNT) {
        console.log(`  ✓ 已达到目标数量 ${TARGET_COUNT}`)
        break
      }
      
      // 点击下一页
      if (pageNum < MAX_PAGES) {
        const nextPageNum = pageNum + 1
        console.log(`  尝试翻到第 ${nextPageNum} 页...`)
        
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1000)
        
        let pageClicked = false
        
        pageClicked = await page.evaluate((targetPage) => {
          const paginationContainers = document.querySelectorAll('[class*="pagination"], [class*="Pagination"], [class*="page-nav"], nav')
          
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
          
          const allElements = document.querySelectorAll('button, a, span, li')
          for (const el of allElements) {
            const text = el.textContent?.trim()
            if (text === String(targetPage) && el.offsetParent !== null) {
              const rect = el.getBoundingClientRect()
              if (rect.top > window.innerHeight * 0.5) {
                el.click()
                return true
              }
            }
          }
          
          const nextBtns = document.querySelectorAll('[class*="next"], [aria-label*="next"], [aria-label*="Next"]')
          for (const btn of nextBtns) {
            if (btn.offsetParent !== null) {
              btn.click()
              return true
            }
          }
          
          return false
        }, nextPageNum)
        
        if (pageClicked) {
          console.log(`  ✓ 翻页成功`)
          await sleep(3000)
        } else {
          console.log(`  ⚠ 未找到分页按钮`)
        }
      }
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
        profile_url: trader.avatar,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const { error } = await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: trader.traderId,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl,
        win_rate: trader.winRate,
        max_drawdown: trader.maxDrawdown,
        followers: trader.followers || 0,
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
  const period = getTargetPeriod()
  console.log(`\n========================================`)
  console.log(`Binance Spot Copy Trading 数据抓取`)
  console.log(`目标周期: ${period}`)
  console.log(`数据源: ${SOURCE}`)
  console.log(`目标数量: ${TARGET_COUNT} 个交易员`)
  console.log(`========================================`)

  try {
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log('\n⚠ 未获取到任何数据')
      console.log('请检查截图文件查看页面状态')
      return
    }

    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    traders.forEach((t, idx) => t.rank = idx + 1)

    const top100 = traders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10 (按 ROI 排序):`)
    top100.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
    })

    const topRoi = top100[0]?.roi || 0
    if (topRoi < 500) {
      console.log(`\n⚠️ 警告: TOP 1 ROI (${topRoi.toFixed(2)}%) 低于 500%，数据可能有问题！`)
    }

    if (top100.length < TARGET_COUNT) {
      console.log(`\n⚠️ 警告: 只获取到 ${top100.length} 个交易员，未达到目标 ${TARGET_COUNT}`)
    }

    const result = await saveTraders(top100, period)

    console.log(`\n========================================`)
    console.log(`✅ 完成！`)
    console.log(`   来源: ${SOURCE}`)
    console.log(`   周期: ${period}`)
    console.log(`   总数: ${top100.length}`)
    console.log(`   TOP ROI: ${topRoi.toFixed(2)}%`)
    console.log(`   保存: ${result.saved}`)
    console.log(`   时间: ${new Date().toISOString()}`)
    console.log(`========================================`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
    console.error(error.stack)
  }
}

main()
