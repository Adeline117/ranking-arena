/**
 * Binance Copy Trading 排行榜数据抓取
 * 
 * 使用 Puppeteer 模拟真实浏览器访问，拦截 API 响应获取数据
 * 
 * 用法: node scripts/import_binance_copy_trading_90d.mjs [7D|30D|90D]
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

// 时间周期配置
const PERIOD_CONFIG = {
  '7D': { 
    tabIndex: 2,  // 0=90D, 1=30D, 2=7D (从右到左)
    urlParam: '7D',
  },
  '30D': { 
    tabIndex: 1,
    urlParam: '30D',
  },
  '90D': { 
    tabIndex: 0,
    urlParam: '90D',
  },
}

const BASE_URL = 'https://www.binance.com/en/copy-trading/leaderboard'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 从命令行参数获取目标周期
 */
function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) {
    return arg
  }
  return '90D'
}

/**
 * 解析 API 响应中的交易员数据
 */
function parseTraderFromApi(item, rank) {
  const traderId = String(item.portfolioId || item.encryptedUid || item.leadPortfolioId || '')
  if (!traderId) return null

  return {
    traderId,
    nickname: item.nickName || item.nickname || item.displayName || null,
    avatar: item.userPhoto || item.avatar || item.avatarUrl || null,
    roi: parseFloat(item.roi ?? item.roiPct ?? item.roiRate ?? 0),
    pnl: parseFloat(item.pnl ?? item.profit ?? item.totalProfit ?? 0),
    winRate: parseFloat(item.winRate ?? item.winRatio ?? 0),
    maxDrawdown: parseFloat(item.mdd ?? item.maxDrawdown ?? 0),
    followers: parseInt(item.copierCount ?? item.followerCount ?? item.followers ?? 0),
    aum: parseFloat(item.aum ?? item.totalAsset ?? 0),
    rank,
  }
}

/**
 * 使用 Puppeteer 抓取排行榜数据
 */
async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Binance ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--start-maximized',
    ],
  })

  const traders = new Map()
  const apiResponses = []

  try {
    const page = await browser.newPage()

    // 设置真实的浏览器指纹
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1920, height: 1080 })
    
    // 设置额外的 headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    })

    // 隐藏 webdriver 标识
    await page.evaluateOnNewDocument(() => {
      // 隐藏 webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      
      // 模拟插件
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ],
      })
      
      // 模拟语言
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      
      // 覆盖 chrome 对象
      window.chrome = { runtime: {} }
      
      // 覆盖权限查询
      const originalQuery = window.navigator.permissions.query
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      )
    })

    // 监听所有网络响应
    page.on('response', async (response) => {
      const url = response.url()
      
      // 检查是否是排行榜相关的 API
      if (url.includes('copy-trade') && 
          (url.includes('query-list') || url.includes('list') || url.includes('home-page'))) {
        try {
          const json = await response.json()
          
          if (json.data && (json.code === '000000' || json.success !== false)) {
            const list = json.data?.list || json.data?.data || (Array.isArray(json.data) ? json.data : [])
            
            if (Array.isArray(list) && list.length > 0) {
              console.log(`  📡 拦截到 API: ${url.split('?')[0].split('/').slice(-2).join('/')} - ${list.length} 条`)
              apiResponses.push({ url, list })
            }
          }
        } catch (e) {
          // 非 JSON 响应
        }
      }
    })

    // 访问排行榜页面
    console.log('📱 访问 Binance Copy Trading 排行榜...')
    
    try {
      await page.goto(BASE_URL, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    
    await sleep(5000)

    // 检查是否有验证码或被阻止
    const pageContent = await page.content()
    if (pageContent.includes('captcha') || pageContent.includes('blocked') || pageContent.includes('Access Denied')) {
      console.log('  ⚠ 检测到访问限制，尝试继续...')
    }

    // 尝试点击时间周期 tab
    console.log(`🔄 切换到 ${period} 时间周期...`)
    
    // 方法1: 尝试通过文本点击
    const clickResult = await page.evaluate((period) => {
      const searchTexts = {
        '7D': ['7 Days', '7D', '7天', '7 天', '7days'],
        '30D': ['30 Days', '30D', '30天', '30 天', '30days'],
        '90D': ['90 Days', '90D', '90天', '90 天', '90days'],
      }
      
      const texts = searchTexts[period] || []
      
      // 查找所有可点击元素
      const elements = document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="tab"], span[class*="tab"], div[class*="filter"], span[class*="filter"], div[class*="option"], span[class*="option"]')
      
      for (const el of elements) {
        const elText = (el.innerText || el.textContent || '').trim().toLowerCase()
        for (const text of texts) {
          if (elText === text.toLowerCase() || elText.includes(text.toLowerCase())) {
            el.click()
            return { success: true, text: elText, method: 'text-match' }
          }
        }
      }
      
      // 尝试查找下拉菜单
      const dropdowns = document.querySelectorAll('select, [class*="select"], [class*="dropdown"]')
      for (const dropdown of dropdowns) {
        dropdown.click?.()
      }
      
      return { success: false }
    }, period)

    if (clickResult.success) {
      console.log(`  ✓ 点击成功: "${clickResult.text}"`)
    } else {
      console.log(`  ⚠ 未找到 ${period} 选择器`)
    }
    
    await sleep(3000)

    // 滚动加载更多
    console.log('📜 滚动加载更多数据...')
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(500)
    }
    
    // 滚回顶部
    await page.evaluate(() => window.scrollTo(0, 0))
    await sleep(2000)

    // 处理收集到的 API 响应
    console.log(`\n📊 处理 ${apiResponses.length} 个 API 响应...`)
    
    for (const { list } of apiResponses) {
      list.forEach((item, idx) => {
        const trader = parseTraderFromApi(item, idx + 1)
        if (trader && trader.traderId) {
          // 如果已存在，更新（保留最高 ROI 的数据）
          const existing = traders.get(trader.traderId)
          if (!existing || trader.roi > existing.roi) {
            traders.set(trader.traderId, trader)
          }
        }
      })
    }

    // 如果 API 没有数据，尝试从页面 DOM 提取
    if (traders.size === 0) {
      console.log('📊 从页面 DOM 提取数据...')
      
      const pageTraders = await page.evaluate(() => {
        const results = []
        const seen = new Set()
        
        // 查找所有交易员卡片
        const cards = document.querySelectorAll('[class*="card"], [class*="item"], [class*="trader"], [class*="portfolio"]')
        
        cards.forEach((card) => {
          const text = card.innerText || ''
          
          // 查找链接获取 ID
          const link = card.querySelector('a[href*="portfolio"], a[href*="lead"], a[href*="trader"]')
          const href = link?.getAttribute('href') || ''
          
          let traderId = null
          const idMatch = href.match(/portfolioId=(\d+)/) || href.match(/encryptedUid=([A-Za-z0-9]+)/)
          traderId = idMatch?.[1]
          
          if (!traderId || seen.has(traderId)) return
          seen.add(traderId)
          
          // 提取 ROI (查找带 % 的数字)
          const roiMatches = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/g)
          let roi = null
          if (roiMatches) {
            for (const match of roiMatches) {
              const val = parseFloat(match.replace(/[^0-9.+-]/g, ''))
              if (val > 0 && (roi === null || val > roi)) {
                roi = val
              }
            }
          }
          
          // 提取昵称
          let nickname = null
          const nameEl = card.querySelector('[class*="name"], [class*="nick"], [class*="title"]')
          if (nameEl) {
            nickname = nameEl.innerText?.trim()?.split('\n')[0]
          }
          
          // 提取头像
          const avatarEl = card.querySelector('img')
          const avatar = avatarEl?.src || null
          
          if (traderId && roi !== null && roi > 0) {
            results.push({
              traderId,
              nickname,
              avatar,
              roi,
              pnl: null,
              winRate: null,
              maxDrawdown: null,
              followers: null,
              rank: results.length + 1,
            })
          }
        })
        
        // 如果卡片方式没找到，尝试查找所有链接
        if (results.length === 0) {
          const links = document.querySelectorAll('a[href*="portfolio"], a[href*="lead-details"]')
          links.forEach((link, idx) => {
            const href = link.getAttribute('href') || ''
            const idMatch = href.match(/portfolioId=(\d+)/)
            const traderId = idMatch?.[1]
            
            if (!traderId || seen.has(traderId)) return
            seen.add(traderId)
            
            // 向上查找容器
            let container = link
            for (let i = 0; i < 8 && container.parentElement; i++) {
              container = container.parentElement
              if (container.innerText?.length > 50) break
            }
            
            const text = container.innerText || ''
            const roiMatch = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/)
            const roi = roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : null
            
            if (traderId && roi !== null && roi > 0) {
              results.push({
                traderId,
                nickname: null,
                avatar: null,
                roi,
                pnl: null,
                winRate: null,
                maxDrawdown: null,
                followers: null,
                rank: idx + 1,
              })
            }
          })
        }
        
        return results
      })
      
      pageTraders.forEach(t => {
        if (!traders.has(t.traderId)) {
          traders.set(t.traderId, t)
        }
      })
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)

    // 截图用于调试
    if (traders.size === 0) {
      const screenshotPath = `/tmp/binance_${period}_${Date.now()}.png`
      await page.screenshot({ path: screenshotPath, fullPage: true })
      console.log(`  📸 截图保存到: ${screenshotPath}`)
    }

  } finally {
    await browser.close()
  }

  return Array.from(traders.values())
}

/**
 * 保存交易员数据到数据库
 */
async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员到数据库 (${period})...`)
  
  const capturedAt = new Date().toISOString()
  let saved = 0
  let errors = 0

  for (const trader of traders) {
    try {
      // 保存 trader_sources
      await supabase.from('trader_sources').upsert({
        source: 'binance',
        source_type: 'leaderboard',
        source_trader_id: trader.traderId,
        handle: trader.nickname,
        profile_url: trader.avatar,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      // 保存 trader_snapshots（只保存当前周期的数据）
      const { error } = await supabase.from('trader_snapshots').upsert({
        source: 'binance',
        source_trader_id: trader.traderId,
        season_id: period,  // 关键：使用传入的周期参数
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl,
        win_rate: trader.winRate,
        max_drawdown: trader.maxDrawdown,
        followers: trader.followers || 0,
        captured_at: capturedAt,
      }, { onConflict: 'source,source_trader_id,season_id,captured_at' })

      if (error) {
        console.error(`  ✗ ${trader.nickname || trader.traderId}: ${error.message}`)
        errors++
      } else {
        saved++
      }
    } catch (error) {
      console.error(`  ✗ ${trader.nickname || trader.traderId}: ${error.message}`)
      errors++
    }
  }

  console.log(`  ✓ 保存成功: ${saved}`)
  if (errors > 0) {
    console.log(`  ✗ 保存失败: ${errors}`)
  }

  return { saved, errors }
}

/**
 * 主函数
 */
async function main() {
  const period = getTargetPeriod()
  console.log(`\n========================================`)
  console.log(`Binance Copy Trading 数据抓取`)
  console.log(`目标周期: ${period}`)
  console.log(`========================================`)

  try {
    // 抓取数据
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log('\n⚠ 未获取到任何数据，跳过保存')
      // 不退出，让 cron 继续执行其他任务
      return
    }

    // 按 ROI 排序
    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

    // 重新分配排名
    traders.forEach((t, idx) => t.rank = idx + 1)

    // 打印 TOP 5
    console.log(`\n📋 ${period} TOP 5:`)
    traders.slice(0, 5).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
    })

    // 保存到数据库
    const result = await saveTraders(traders, period)

    console.log(`\n✅ 完成！`)
    console.log(`   周期: ${period}`)
    console.log(`   总数: ${traders.length}`)
    console.log(`   保存: ${result.saved}`)
    console.log(`   时间: ${new Date().toISOString()}`)

  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
    // 不退出，让 cron 继续执行其他任务
  }
}

main()
