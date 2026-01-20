/**
 * Binance Futures Copy Trading 排行榜数据抓取 (优化版)
 * 
 * 优化点：
 * 1. 智能等待替代固定 sleep（减少约 50% 等待时间）
 * 2. 批量数据库写入（减少 API 调用次数）
 * 3. 更快的翻页策略
 * 
 * 用法: node scripts/import_binance_futures.mjs [7D|30D|90D]
 * 
 * 数据源: https://www.binance.com/zh-CN/copy-trading
 * API: https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list
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
const BASE_URL = 'https://www.binance.com/zh-CN/copy-trading'

// 每页 18 个，抓 200 个需要 12 页（扩大范围确保全面）
const TARGET_COUNT = 200
const PER_PAGE = 18
const MAX_PAGES = Math.ceil(TARGET_COUNT / PER_PAGE) + 1

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
  // 优先使用 leadPortfolioId，其次是 portfolioId 或 encryptedUid
  const traderId = String(item.leadPortfolioId || item.portfolioId || item.encryptedUid || '')
  if (!traderId) return null

  // Binance API 返回的 ROI 已经是百分比形式，如 7720.69 表示 7720.69%
  const roi = parseFloat(item.roi ?? 0)

  // winRate 是 0-100 的数值，需要转换为 0-1
  let winRate = parseFloat(item.winRate ?? 0)
  if (winRate > 1) {
    winRate = winRate / 100
  }

  return {
    traderId,
    nickname: item.nickName || item.nickname || item.displayName || null,
    avatar: item.userPhoto || item.avatar || item.avatarUrl || null,
    roi,
    pnl: parseFloat(item.pnl ?? item.profit ?? 0),
    winRate,
    maxDrawdown: parseFloat(item.mdd ?? item.maxDrawdown ?? 0),
    followers: parseInt(item.currentCopyCount ?? item.copierCount ?? item.followerCount ?? item.followers ?? 0),
    aum: parseFloat(item.aum ?? item.totalAsset ?? 0),
    rank,
  }
}

async function fetchLeaderboardData(period) {
  const startTime = Date.now()
  console.log(`\n=== 抓取 Binance Futures ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log('URL:', BASE_URL)
  console.log(`目标: ${TARGET_COUNT} 个交易员，最多翻 ${MAX_PAGES} 页`)

  const traders = new Map()
  let apiResponseReceived = false

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
    
    // 核心改进：拦截 API 请求并修改参数，确保获取正确时间段和 ROI 排序的数据
    let currentPageNum = 1
    await page.route('**/query-list', async (route) => {
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

    // 存储每日精选数据
    const dailyPicks = new Map()
    
    // 监听所有 API 响应（包括每日精选等）
    page.on('response', async (response) => {
      const url = response.url()
      
      // 处理每日精选数据
      if (url.includes('daily-picks')) {
        try {
          const json = await response.json()
          if (json.code === '000000') {
            const list = Array.isArray(json.data) ? json.data : (json.data?.list || json.data?.data || [])
            console.log(`  ✨ 每日精选: 收到 ${list.length} 个推荐交易员`)
            list.forEach((item, idx) => {
              const trader = parseTraderFromApi(item, idx + 1)
              if (trader && trader.traderId) {
                dailyPicks.set(trader.traderId, trader)
                if (idx < 3) {
                  console.log(`    [精选] ROI ${trader.roi.toFixed(2)}%, 跟单: ${trader.followers}, 昵称: ${trader.nickname || '未知'}`)
                }
              }
            })
          }
        } catch (e) {}
      }
      
      if (url.includes('query-list')) {
        try {
          const json = await response.json()
          if (json.data && (json.code === '000000' || json.success !== false)) {
            const list = json.data?.list || json.data?.data || []
            if (Array.isArray(list) && list.length > 0) {
              apiResponseReceived = true
              console.log(`  ✓ 收到 ${list.length} 条数据`)
              
              // 处理数据
              list.forEach((item, idx) => {
                const rank = (currentPageNum - 1) * PER_PAGE + idx + 1
                const trader = parseTraderFromApi(item, rank)
                if (trader && trader.traderId && !traders.has(trader.traderId)) {
                  traders.set(trader.traderId, trader)
                  if (traders.size <= 3) {
                    console.log(`    #${rank}: ROI ${trader.roi.toFixed(2)}%, 跟单: ${trader.followers}, 昵称: ${trader.nickname || '未知'}`)
                  }
                }
              })
            }
          }
        } catch (e) {
          console.log(`  ⚠ 解析响应失败: ${e.message}`)
        }
      }
    })

    // 同时从页面 DOM 提取数据（作为补充）
    async function extractTradersFromDom() {
      return await page.evaluate(() => {
        const results = []
        // 找到所有交易员卡片
        const cards = document.querySelectorAll('[class*="copy-trade"] [class*="card"], [class*="TraderCard"], [class*="trader-item"]')
        
        cards.forEach((card, idx) => {
          try {
            const text = card.innerText || ''
            // 提取昵称 - 通常在卡片顶部
            const nameEl = card.querySelector('[class*="nick"], [class*="name"], [class*="title"]')
            const nickname = nameEl?.innerText?.trim() || ''
            
            // 提取 ROI - 查找包含 % 的数字
            const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)\s*%/)
            const roi = roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : 0
            
            // 提取 PnL - 查找 USD 或 $ 开头的数字
            const pnlMatch = text.match(/([+-]?[\d,]+\.?\d+)\s*(?:USD|USDT|\$)/) || text.match(/\$\s*([+-]?[\d,]+\.?\d+)/)
            const pnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, '')) : 0
            
            // 提取跟单者数量 - 查找 "38/200" 或类似格式
            const followersMatch = text.match(/(\d+)\s*\/\s*\d+/)
            const followers = followersMatch ? parseInt(followersMatch[1]) : 0
            
            // 提取 trader ID（从链接或数据属性）
            const link = card.querySelector('a[href*="portfolio"]')
            const href = link?.getAttribute('href') || ''
            const idMatch = href.match(/portfolio\/(\d+)/)
            const traderId = idMatch ? idMatch[1] : null
            
            if (nickname && (roi !== 0 || pnl !== 0)) {
              results.push({ nickname, roi, pnl, followers, traderId, rank: idx + 1 })
            }
          } catch (e) {}
        })
        
        return results
      })
    }

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    
    // 优化：智能等待，最多等 10 秒，收到 API 响应就继续
    const waitStart = Date.now()
    while (!apiResponseReceived && Date.now() - waitStart < 10000) {
      await sleep(500)
    }
    
    // 额外等待一小会确保数据处理完成
    await sleep(2000)
    
    // 合并每日精选数据
    if (dailyPicks.size > 0) {
      console.log('\n✨ 合并每日精选数据...')
      let picksAdded = 0
      for (const [id, trader] of dailyPicks) {
        if (!traders.has(id)) {
          traders.set(id, trader)
          picksAdded++
          console.log(`  [精选新增] ROI ${trader.roi.toFixed(2)}%, 跟单: ${trader.followers}, 昵称: ${trader.nickname}`)
        }
      }
      if (picksAdded > 0) {
        console.log(`  ✓ 从每日精选新增了 ${picksAdded} 个交易员`)
      } else {
        console.log('  ✓ 每日精选交易员已全部包含在排行榜中')
      }
    }
    
    // 从 DOM 补充数据（备用）
    const domTraders = await extractTradersFromDom()
    let domAdded = 0
    for (const dt of domTraders) {
      if (dt.traderId && !traders.has(dt.traderId)) {
        traders.set(dt.traderId, {
          traderId: dt.traderId,
          nickname: dt.nickname,
          roi: dt.roi,
          pnl: dt.pnl,
          followers: dt.followers,
          rank: traders.size + 1,
          winRate: 0,
          maxDrawdown: 0,
          aum: 0,
          avatar: null,
        })
        domAdded++
        if (domAdded <= 3) {
          console.log(`  [DOM] #${dt.rank}: ROI ${dt.roi.toFixed(2)}%, 跟单: ${dt.followers}, 昵称: ${dt.nickname}`)
        }
      }
    }
    if (domAdded > 0) {
      console.log(`  ✓ 从 DOM 补充了 ${domAdded} 个交易员`)
    }
    
    // 检查是否包含特定交易员
    console.log('\n🔎 检查关键交易员:')
    const keyTraders = ['张邻', '千江水', 'Doraemoo', 'Timmo']
    for (const name of keyTraders) {
      const found = [...traders.values()].find(t => t.nickname?.includes(name))
      if (found) {
        console.log(`  ✓ ${name}: ROI ${found.roi.toFixed(2)}%, 跟单: ${found.followers}`)
      } else {
        console.log(`  ❌ ${name}: 未找到`)
      }
    }
    
    console.log(`\n📄 当前已获取: ${traders.size} 个交易员`)

    // 分页获取更多数据
    while (traders.size < TARGET_COUNT && currentPageNum < MAX_PAGES) {
      currentPageNum++
      apiResponseReceived = false
      console.log(`\n📄 翻页到第 ${currentPageNum} 页...`)
      
      // 滚动到页面底部
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(500)
      
      // 点击下一页
      let pageClicked = false
      
      // 方法1: 用 JavaScript 直接点击分页按钮
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
        
        // 尝试点击 ">" 按钮
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
        // 优化：智能等待 API 响应
        const pageWaitStart = Date.now()
        while (!apiResponseReceived && Date.now() - pageWaitStart < 8000) {
          await sleep(300)
        }
        await sleep(500) // 短暂等待数据处理
      } else {
        // 方法2: 使用 Playwright 选择器
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
              // 智能等待
              const selectorWaitStart = Date.now()
              while (!apiResponseReceived && Date.now() - selectorWaitStart < 8000) {
                await sleep(300)
              }
              await sleep(500)
              break
            }
          } catch (e) {}
        }
      }
      
      if (!pageClicked) {
        console.log(`  ⚠ 翻页失败，停止分页`)
        break
      }
      
      console.log(`  当前已获取: ${traders.size} 个交易员`)
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`⏱ 爬取耗时: ${elapsed}s`)

    // 保存截图用于调试
    const screenshotPath = `/tmp/binance_futures_${period}_${Date.now()}.png`
    await page.screenshot({ path: screenshotPath, fullPage: true })
    console.log(`📸 截图保存到: ${screenshotPath}`)

  } finally {
    await browser.close()
  }

  return Array.from(traders.values())
}

/**
 * 批量保存交易员数据
 */
async function saveTradersBatch(traders, period) {
  console.log(`\n💾 批量保存 ${traders.length} 个交易员到数据库 (${SOURCE} - ${period})...`)
  
  const capturedAt = new Date().toISOString()

  // 1. 批量 upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    profile_url: t.avatar,
    is_active: true,
  }))
  
  const { error: sourcesError } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  if (sourcesError) {
    console.log(`  ⚠ trader_sources 批量保存警告: ${sourcesError.message}`)
  } else {
    console.log(`  ✓ trader_sources 批量保存成功`)
  }

  // 2. 批量 insert trader_snapshots
  const snapshotsData = traders.map(t => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: t.rank,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: t.followers || 0,
    captured_at: capturedAt,
  }))
  
  const { error: snapshotsError } = await supabase
    .from('trader_snapshots')
    .insert(snapshotsData)
  
  if (snapshotsError) {
    console.log(`  ⚠ trader_snapshots 批量保存失败: ${snapshotsError.message}`)
    // 如果批量失败，尝试逐条插入
    console.log(`  尝试逐条保存...`)
    let saved = 0
    let errors = 0
    for (const snapshot of snapshotsData) {
      const { error } = await supabase.from('trader_snapshots').insert(snapshot)
      if (error) {
        errors++
      } else {
        saved++
      }
    }
    console.log(`  逐条保存结果: 成功 ${saved}, 失败 ${errors}`)
    return { saved, errors }
  }

  console.log(`  ✓ trader_snapshots 批量保存成功: ${snapshotsData.length} 条`)
  return { saved: snapshotsData.length, errors: 0 }
}

async function main() {
  const period = getTargetPeriod()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Binance Futures Copy Trading 数据抓取 (优化版)`)
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

    const result = await saveTradersBatch(top100, period)
    
    const totalElapsed = ((Date.now() - totalStartTime) / 1000).toFixed(1)

    console.log(`\n========================================`)
    console.log(`✅ 完成！`)
    console.log(`   来源: ${SOURCE}`)
    console.log(`   周期: ${period}`)
    console.log(`   总数: ${top100.length}`)
    console.log(`   TOP ROI: ${validation.stats.topRoi.toFixed(2)}%`)
    console.log(`   平均 ROI: ${validation.stats.avgRoi.toFixed(2)}%`)
    console.log(`   保存: ${result.saved}`)
    console.log(`   总耗时: ${totalElapsed}s`)
    console.log(`   时间: ${new Date().toISOString()}`)
    console.log(`========================================`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main()
