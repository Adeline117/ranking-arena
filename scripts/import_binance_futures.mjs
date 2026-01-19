/**
 * Binance Futures Copy Trading 排行榜数据抓取
 * 
 * 使用 Playwright 模拟真实浏览器，抓取合约跟单排行榜
 * 按收益率(ROI)从高到低排序，支持分页
 * 
 * 用法: node scripts/import_binance_futures.mjs [7D|30D|90D]
 * 
 * 数据源: https://www.binance.com/zh-CN/copy-trading
 */

import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { validateTraderData, deduplicateTraders, printValidationResult } from './lib/data-validation.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'binance_futures'
// 使用中文版
const BASE_URL = 'https://www.binance.com/zh-CN/copy-trading'

// 每页 18 个，抓 100 个需要 6 页
const TARGET_COUNT = 100
const PER_PAGE = 18
const MAX_PAGES = Math.ceil(TARGET_COUNT / PER_PAGE) + 1 // 7 页确保够

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

  // ROI 可能是小数（如 1.5 表示 150%）或百分比（如 150）
  let roi = parseFloat(item.roi ?? item.roiPct ?? item.roiRate ?? 0)
  // 如果 ROI < 10，可能是小数形式，转换为百分比
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
  console.log(`\n=== 抓取 Binance Futures ${period} 排行榜 ===`)
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

    // 监听 API 响应
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy-trade') && (url.includes('query-list') || url.includes('list') || url.includes('home-page') || url.includes('rank'))) {
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
    const sortSelectors = [
      `text=${config.sortText}`,
      `button:has-text("${config.sortText}")`,
      `div:has-text("${config.sortText}")`,
      `span:has-text("${config.sortText}")`,
      `[class*="sort"]:has-text("${config.sortText}")`,
      `th:has-text("${config.sortText}")`,
    ]
    
    let sortClicked = false
    for (const selector of sortSelectors) {
      try {
        const element = await page.$(selector)
        if (element) {
          await element.click()
          console.log(`  ✓ 点击成功: "${config.sortText}"`)
          sortClicked = true
          await sleep(3000)
          break
        }
      } catch (e) {}
    }
    
    if (!sortClicked) {
      console.log(`  ⚠ 未找到收益率排序按钮，继续...`)
    }

    // 步骤 2: 切换时间周期（Binance 使用下拉菜单选择时间）
    console.log(`\n🔄 切换到 ${period} 时间周期...`)
    let periodSwitched = false
    
    try {
      // 滚动到页面顶部确保下拉菜单可见
      await page.evaluate(() => window.scrollTo(0, 0))
      await sleep(1000)
      
      // 使用 Playwright locator 查找包含"天"的下拉选择器
      const selectTrigger = page.locator('[class*="bn-select"]:has-text("天")').first()
      
      if (await selectTrigger.count() > 0) {
        console.log(`  找到时间下拉菜单，点击打开...`)
        await selectTrigger.click()
        await sleep(1000)
        
        // 选择目标时间
        for (const tabText of config.tabTexts) {
          // 查找下拉选项
          const option = page.locator(`[class*="bn-select-option"]:has-text("${tabText}")`).first()
          
          if (await option.count() > 0) {
            await option.click()
            console.log(`  ✓ 时间切换成功: "${tabText}"`)
            periodSwitched = true
            await sleep(3000)
            // 清空之前的 API 响应，只收集新数据
            apiResponses.length = 0
            break
          }
        }
      }
      
      // 备用方案：直接点击包含目标时间文字的元素
      if (!periodSwitched) {
        for (const tabText of config.tabTexts) {
          const timeElements = page.locator(`text=${tabText}`).all()
          const elements = await timeElements
          
          for (const el of elements) {
            try {
              const box = await el.boundingBox()
              // 只点击页面上半部分的时间元素（避免点击到其他地方）
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
      console.log(`  ⚠ 未找到时间切换按钮，使用默认数据（30天）`)
    }

    // 步骤 3: 分页获取数据
    console.log('\n📄 开始分页获取数据...')
    
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      console.log(`\n  === 第 ${pageNum} 页 ===`)
      
      // 等待数据加载
      await sleep(2000)
      
      // 滚动页面确保数据加载
      await page.evaluate(() => window.scrollBy(0, 500))
      await sleep(1000)
      
      // 处理当前页的 API 响应
      const currentResponses = apiResponses.filter(r => r.timestamp > Date.now() - 10000)
      for (const { list } of currentResponses) {
        list.forEach((item, idx) => {
          const trader = parseTraderFromApi(item, traders.size + idx + 1)
          if (trader && trader.traderId && !traders.has(trader.traderId)) {
            traders.set(trader.traderId, trader)
          }
        })
      }
      
      console.log(`  当前已获取: ${traders.size} 个交易员`)
      
      // 如果已经够了就停止
      if (traders.size >= TARGET_COUNT) {
        console.log(`  ✓ 已达到目标数量 ${TARGET_COUNT}`)
        break
      }
      
      // 点击下一页
      if (pageNum < MAX_PAGES) {
        const nextPageNum = pageNum + 1
        console.log(`  尝试翻到第 ${nextPageNum} 页...`)
        
        // 先滚动到页面底部让分页按钮可见
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1000)
        
        let pageClicked = false
        
        // 方法1: 用 JavaScript 直接点击分页按钮
        pageClicked = await page.evaluate((targetPage) => {
          // 查找所有可能的分页容器
          const paginationContainers = document.querySelectorAll('[class*="pagination"], [class*="Pagination"], [class*="page-nav"], nav')
          
          for (const container of paginationContainers) {
            // 在分页容器中查找目标页码
            const buttons = container.querySelectorAll('button, a, span, li')
            for (const btn of buttons) {
              const text = btn.textContent?.trim()
              if (text === String(targetPage)) {
                btn.click()
                return true
              }
            }
          }
          
          // 如果没找到容器，尝试直接查找页码元素
          const allElements = document.querySelectorAll('button, a, span, li')
          for (const el of allElements) {
            const text = el.textContent?.trim()
            // 精确匹配页码数字
            if (text === String(targetPage) && el.offsetParent !== null) {
              // 检查是否在页面底部区域（分页通常在底部）
              const rect = el.getBoundingClientRect()
              if (rect.top > window.innerHeight * 0.5) {
                el.click()
                return true
              }
            }
          }
          
          // 尝试点击 ">" 或 "下一页" 按钮
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
          console.log(`  ✓ 翻页成功 (方法1)`)
          await sleep(3000)
        } else {
          // 方法2: 使用 Playwright 选择器
          const pageSelectors = [
            `li:has-text("${nextPageNum}"):not(:has-text("${nextPageNum}0"))`,
            `button:text-is("${nextPageNum}")`,
            `a:text-is("${nextPageNum}")`,
            `span:text-is("${nextPageNum}")`,
            `[class*="pagination"] >> text="${nextPageNum}"`,
            `nav >> text="${nextPageNum}"`,
          ]
          
          for (const selector of pageSelectors) {
            try {
              const element = await page.$(selector)
              if (element) {
                const isVisible = await element.isVisible()
                if (isVisible) {
                  await element.click()
                  console.log(`  ✓ 翻页成功 (方法2: ${selector})`)
                  pageClicked = true
                  await sleep(3000)
                  break
                }
              }
            } catch (e) {}
          }
        }
        
        if (!pageClicked) {
          console.log(`  ⚠ 未找到分页按钮`)
        }
      }
    }

    // 如果 API 拦截数据不够，尝试从 DOM 提取
    if (traders.size < TARGET_COUNT) {
      console.log('\n📊 从页面 DOM 补充提取数据...')
      const pageTraders = await page.evaluate(() => {
        const results = []
        const seen = new Set()
        
        // 查找所有交易员卡片或行
        const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], tr')
        
        cards.forEach((card) => {
          const text = card.innerText || ''
          
          // 查找链接中的 ID
          const link = card.querySelector('a[href*="portfolio"], a[href*="lead"], a[href*="trader"]')
          const href = link?.getAttribute('href') || ''
          const idMatch = href.match(/portfolioId=(\d+)/) || href.match(/encryptedUid=([A-Za-z0-9]+)/) || href.match(/\/(\d{10,})/)
          const traderId = idMatch?.[1]
          
          if (!traderId || seen.has(traderId)) return
          seen.add(traderId)
          
          // 提取 ROI（查找百分比数字）
          const roiMatches = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/g)
          let roi = null
          if (roiMatches) {
            for (const match of roiMatches) {
              const val = parseFloat(match.replace(/[^0-9.+-]/g, ''))
              // 选择最大的正数作为 ROI
              if (val > 0 && (roi === null || val > roi)) {
                roi = val
              }
            }
          }
          
          // 提取昵称
          let nickname = null
          const nameEl = card.querySelector('[class*="name"], [class*="nick"]')
          if (nameEl) {
            nickname = nameEl.innerText?.trim()?.split('\n')[0]
          }
          
          if (traderId && roi !== null && roi > 0) {
            results.push({
              traderId,
              nickname,
              avatar: null,
              roi,
              pnl: null,
              winRate: null,
              maxDrawdown: null,
              followers: null,
              rank: results.length + 1,
            })
          }
        })
        
        return results
      })
      
      console.log(`  从 DOM 提取到 ${pageTraders.length} 个交易员`)
      pageTraders.forEach(t => {
        if (!traders.has(t.traderId)) {
          traders.set(t.traderId, t)
        }
      })
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)

    // 保存截图用于调试
    const screenshotPath = `/tmp/binance_futures_${period}_${Date.now()}.png`
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
      // trader_sources 可以 upsert
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: trader.traderId,
        handle: trader.nickname,
        profile_url: trader.avatar,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      // trader_snapshots 使用 insert（每次抓取都是新快照）
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
  console.log(`Binance Futures Copy Trading 数据抓取`)
  console.log(`目标周期: ${period}`)
  console.log(`数据源: ${SOURCE}`)
  console.log(`目标数量: ${TARGET_COUNT} 个交易员`)
  console.log(`========================================`)

  try {
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log('\n⚠ 未获取到任何数据')
      console.log('请检查截图文件查看页面状态')
      process.exit(1)
    }

    // 去重
    const uniqueTraders = deduplicateTraders(traders)
    
    // 按 ROI 从高到低排序
    uniqueTraders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    uniqueTraders.forEach((t, idx) => t.rank = idx + 1)

    // 只保留前 100 个
    const top100 = uniqueTraders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10 (按 ROI 排序):`)
    top100.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
    })

    // 数据质量验证
    const validation = validateTraderData(top100, {}, SOURCE)
    const isValid = printValidationResult(validation, SOURCE)

    if (!isValid) {
      console.log('\n❌ 数据质量验证失败，不保存数据')
      console.log('请检查截图文件查看页面状态')
      process.exit(1)
    }

    const result = await saveTraders(top100, period)

    console.log(`\n========================================`)
    console.log(`✅ 完成！`)
    console.log(`   来源: ${SOURCE}`)
    console.log(`   周期: ${period}`)
    console.log(`   总数: ${top100.length}`)
    console.log(`   TOP ROI: ${validation.stats.topRoi.toFixed(2)}%`)
    console.log(`   平均 ROI: ${validation.stats.avgRoi.toFixed(2)}%`)
    console.log(`   保存: ${result.saved}`)
    console.log(`   时间: ${new Date().toISOString()}`)
    console.log(`========================================`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main()
