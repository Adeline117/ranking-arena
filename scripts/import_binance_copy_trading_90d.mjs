/**
 * Binance Copy Trading 排行榜数据抓取
 * 
 * 使用 Puppeteer 模拟浏览器访问 Binance 排行榜页面，
 * 拦截 API 响应获取真实的 7D/30D/90D 数据
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
    tabText: ['7 Days', '7Days', '7D', '7天', '7 天'],
    apiTimeRange: ['WEEKLY', '7D', '7'],
  },
  '30D': { 
    tabText: ['30 Days', '30Days', '30D', '30天', '30 天'],
    apiTimeRange: ['MONTHLY', '30D', '30'],
  },
  '90D': { 
    tabText: ['90 Days', '90Days', '90D', '90天', '90 天'],
    apiTimeRange: ['QUARTERLY', '90D', '90'],
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
  return '90D' // 默认 90D
}

/**
 * 解析 API 响应中的交易员数据
 */
function parseTraderFromApi(item, rank) {
  const traderId = String(item.portfolioId || item.encryptedUid || item.leadPortfolioId || '')
  if (!traderId) return null

  // ROI 可能是小数（如 23.47 表示 2347%）或百分比值（如 2347.01）
  let roi = parseFloat(item.roi ?? item.roiPct ?? item.roiRate ?? 0)
  // 如果 ROI 看起来像是小数形式（如 23.47），转换为百分比
  // Binance 返回的 ROI 通常已经是百分比值
  
  return {
    traderId,
    nickname: item.nickName || item.nickname || item.displayName || null,
    avatar: item.userPhoto || item.avatar || item.avatarUrl || null,
    roi,
    pnl: parseFloat(item.pnl ?? item.profit ?? item.totalProfit ?? 0),
    winRate: parseFloat(item.winRate ?? item.winRatio ?? 0),
    maxDrawdown: parseFloat(item.mdd ?? item.maxDrawdown ?? 0),
    followers: parseInt(item.copierCount ?? item.followerCount ?? item.followers ?? 0),
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
      '--disable-web-security',
    ],
  })

  const traders = []
  let apiDataReceived = false

  try {
    const page = await browser.newPage()

    // 设置真实的浏览器指纹
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1920, height: 1080 })

    // 隐藏 webdriver 标识
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
    })

    // 监听 API 响应
    const config = PERIOD_CONFIG[period]
    
    page.on('response', async (response) => {
      const url = response.url()
      
      // 检查是否是排行榜 API
      if (url.includes('copy-trade') && 
          (url.includes('query-list') || url.includes('list') || url.includes('leaderboard'))) {
        try {
          const json = await response.json()
          
          // 检查是否是我们要的时间周期的数据
          const urlLower = url.toLowerCase()
          const isTargetPeriod = config.apiTimeRange.some(tr => 
            urlLower.includes(tr.toLowerCase()) || 
            url.includes(`timeRange=${tr}`) ||
            url.includes(`period=${tr}`)
          )
          
          if (json.data && (json.code === '000000' || json.success)) {
            const list = json.data?.list || json.data?.data || (Array.isArray(json.data) ? json.data : [])
            
            if (Array.isArray(list) && list.length > 0) {
              console.log(`  📡 拦截到 API 响应: ${list.length} 个交易员`)
              
              list.forEach((item, idx) => {
                const trader = parseTraderFromApi(item, idx + 1)
                if (trader && !traders.find(t => t.traderId === trader.traderId)) {
                  traders.push(trader)
                }
              })
              
              apiDataReceived = true
            }
          }
        } catch (e) {
          // 非 JSON 响应，忽略
        }
      }
    })

    // 访问排行榜页面
    console.log('📱 访问 Binance Copy Trading 排行榜...')
    await page.goto(BASE_URL, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    })
    await sleep(3000)

    // 尝试点击时间周期 tab
    console.log(`🔄 切换到 ${period} 时间周期...`)
    
    const clicked = await page.evaluate((tabTexts) => {
      // 查找所有可能的 tab 元素
      const elements = document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="tab"], span[class*="tab"], div[class*="filter"], span[class*="filter"]')
      
      for (const el of elements) {
        const text = (el.innerText || el.textContent || '').trim()
        for (const tabText of tabTexts) {
          if (text === tabText || text.includes(tabText)) {
            el.click()
            return { success: true, text }
          }
        }
      }
      
      // 尝试查找下拉选择器
      const selects = document.querySelectorAll('select, [class*="select"], [class*="dropdown"]')
      for (const select of selects) {
        const options = select.querySelectorAll('option, [role="option"]')
        for (const option of options) {
          const text = (option.innerText || option.textContent || '').trim()
          for (const tabText of tabTexts) {
            if (text === tabText || text.includes(tabText)) {
              option.click()
              return { success: true, text, type: 'dropdown' }
            }
          }
        }
      }
      
      return { success: false }
    }, config.tabText)

    if (clicked.success) {
      console.log(`  ✓ 点击成功: "${clicked.text}"`)
      await sleep(3000)
    } else {
      console.log(`  ⚠ 未找到 ${period} tab，尝试从页面提取数据...`)
    }

    // 滚动加载更多数据
    console.log('📜 滚动加载更多数据...')
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 800))
      await sleep(800)
    }

    // 如果没有从 API 获取到数据，尝试从页面 DOM 提取
    if (traders.length === 0) {
      console.log('📊 从页面 DOM 提取数据...')
      
      const pageTraders = await page.evaluate(() => {
        const results = []
        const seen = new Set()
        
        // 查找所有链接到交易员详情页的元素
        const links = document.querySelectorAll('a[href*="lead"], a[href*="portfolio"], a[href*="trader"]')
        
        links.forEach((link, idx) => {
          const href = link.getAttribute('href') || ''
          
          // 提取 ID
          let traderId = null
          const portfolioIdMatch = href.match(/portfolioId=(\d+)/)
          const encryptedUidMatch = href.match(/encryptedUid=([A-Za-z0-9]+)/)
          traderId = portfolioIdMatch?.[1] || encryptedUidMatch?.[1]
          
          if (!traderId || seen.has(traderId)) return
          seen.add(traderId)
          
          // 向上查找包含完整信息的容器
          let container = link
          for (let i = 0; i < 10 && container.parentElement; i++) {
            container = container.parentElement
            const text = container.innerText || ''
            if (text.includes('ROI') || text.includes('%')) break
          }
          
          const text = container.innerText || ''
          
          // 提取 ROI
          const roiMatches = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/g)
          let roi = null
          if (roiMatches && roiMatches.length > 0) {
            // 取第一个百分比值作为 ROI
            const roiStr = roiMatches[0].replace(/[^0-9.+-]/g, '')
            roi = parseFloat(roiStr)
          }
          
          // 提取昵称
          const nameEl = container.querySelector('[class*="name"], [class*="nick"], [class*="title"]')
          const nickname = nameEl?.innerText?.trim()?.split('\n')[0] || null
          
          // 提取头像
          const avatarEl = container.querySelector('img[src*="avatar"], img[src*="profile"], img')
          const avatar = avatarEl?.src || null
          
          if (traderId && roi !== null) {
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
        
        return results
      })
      
      pageTraders.forEach(t => {
        if (!traders.find(tr => tr.traderId === t.traderId)) {
          traders.push(t)
        }
      })
    }

    console.log(`\n📊 共获取 ${traders.length} 个交易员数据`)

  } finally {
    await browser.close()
  }

  return traders
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

      // 保存 trader_snapshots（只保存当前周期）
      const { error } = await supabase.from('trader_snapshots').upsert({
        source: 'binance',
        source_trader_id: trader.traderId,
        season_id: period,
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
      console.log('\n⚠ 未获取到任何数据')
      process.exit(1)
    }

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
    process.exit(1)
  }
}

main()
