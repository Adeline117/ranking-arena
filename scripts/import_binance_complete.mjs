/**
 * Binance 完整数据抓取
 * 通过拦截 API 请求获取 7D/30D/90D 排行榜数据
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Binance 排行榜周期
const PERIODS = [
  { days: 90, label: '90D' },
  { days: 30, label: '30D' },
  { days: 7, label: '7D' },
]

const BASE_URL = 'https://www.binance.com/en/copy-trading/leaderboard'

async function main() {
  console.log('=== Binance 完整数据抓取 (API 拦截模式) ===\n')
  console.log('开始时间:', new Date().toISOString())

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  })

  try {
    const page = await browser.newPage()
    
    // 设置真实的浏览器指纹
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1920, height: 1080 })
    
    // 隐藏 webdriver 标识
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    // 存储所有交易员数据
    const allTraders = new Map()
    
    // 存储拦截到的 API 响应
    const apiResponses = []

    // 设置请求拦截
    await page.setRequestInterception(true)
    
    page.on('request', (request) => {
      // 阻止一些不必要的资源
      const resourceType = request.resourceType()
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        request.abort()
      } else {
        request.continue()
      }
    })

    // 监听响应
    page.on('response', async (response) => {
      const url = response.url()
      
      // 捕获排行榜 API 响应
      if (url.includes('/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list') ||
          url.includes('/bapi/futures/v2/friendly/future/copy-trade/home-page/query-list') ||
          url.includes('/bapi/futures/v1/public/future/copy-trade/lead-portfolio/list') ||
          url.includes('copy-trade') && url.includes('list')) {
        try {
          const json = await response.json()
          console.log(`  📡 拦截到 API 响应: ${url.split('?')[0]}`)
          if (json.data) {
            apiResponses.push(json)
          }
        } catch (e) {
          // 非 JSON 响应，忽略
        }
      }
    })

    // 访问排行榜页面
    console.log('访问 Binance Copy Trading 排行榜...')
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(5000)

    // 尝试获取页面上的数据
    console.log('\n📊 分析页面结构...')
    
    const pageInfo = await page.evaluate(() => {
      const body = document.body
      const text = body.innerText
      
      // 查找所有可能包含交易员信息的元素
      const allElements = document.querySelectorAll('*')
      const potentialCards = []
      
      allElements.forEach(el => {
        const className = el.className || ''
        const text = el.innerText || ''
        
        // 查找包含 ROI 和交易员链接的元素
        if (text.includes('ROI') && text.includes('%') && el.querySelector('a')) {
          potentialCards.push({
            tag: el.tagName,
            className: className.toString().substring(0, 100),
            hasLink: !!el.querySelector('a[href*="lead"]'),
            textLength: text.length,
          })
        }
      })
      
      return {
        title: document.title,
        url: window.location.href,
        bodyLength: text.length,
        hasROI: text.includes('ROI'),
        hasPnL: text.includes('PnL') || text.includes('Profit'),
        potentialCards: potentialCards.slice(0, 10),
        sampleText: text.substring(0, 2000),
      }
    })
    
    console.log(`  页面标题: ${pageInfo.title}`)
    console.log(`  页面 URL: ${pageInfo.url}`)
    console.log(`  页面文本长度: ${pageInfo.bodyLength}`)
    console.log(`  包含 ROI: ${pageInfo.hasROI}`)
    console.log(`  包含 PnL: ${pageInfo.hasPnL}`)
    console.log(`  潜在卡片元素: ${pageInfo.potentialCards.length}`)
    
    if (pageInfo.potentialCards.length > 0) {
      console.log('  卡片示例:', JSON.stringify(pageInfo.potentialCards[0], null, 2))
    }

    // 尝试点击不同时间段的 tab
    for (const period of PERIODS) {
      console.log(`\n📊 尝试获取 ${period.label} 数据...`)
      
      // 尝试多种方式点击时间段选择器
      const clicked = await page.evaluate((periodLabel) => {
        // 方法1：查找包含时间段文本的按钮
        const buttons = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="tab"], span[class*="tab"]'))
        for (const btn of buttons) {
          const text = btn.innerText || btn.textContent || ''
          if (text.includes(periodLabel) || text.includes(periodLabel.replace('D', ' Day')) || text.includes(periodLabel.replace('D', '天'))) {
            btn.click()
            return { success: true, method: 'text-match', text: text.trim() }
          }
        }
        
        // 方法2：查找数字按钮（7, 30, 90）
        const days = periodLabel.replace('D', '')
        for (const btn of buttons) {
          const text = (btn.innerText || '').trim()
          if (text === days || text === `${days}D` || text === `${days} Days` || text === `${days}天`) {
            btn.click()
            return { success: true, method: 'number-match', text }
          }
        }
        
        return { success: false }
      }, period.label)
      
      if (clicked.success) {
        console.log(`  ✓ 点击成功 (${clicked.method}): "${clicked.text}"`)
        await sleep(3000)
      } else {
        console.log(`  ✗ 未找到 ${period.label} 选择器`)
      }

      // 滚动加载更多
      console.log('  滚动加载更多数据...')
      for (let i = 0; i < 15; i++) {
        await page.evaluate(() => window.scrollBy(0, 800))
        await sleep(500)
      }
      
      // 滚动回顶部
      await page.evaluate(() => window.scrollTo(0, 0))
      await sleep(1000)

      // 提取当前页面的数据
      const traders = await page.evaluate(() => {
        const results = []
        const seen = new Set()
        
        // 查找所有链接到交易员详情页的元素
        const links = document.querySelectorAll('a[href*="lead-details"], a[href*="portfolioId"], a[href*="encryptedUid"]')
        
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
            if (text.includes('ROI') && text.includes('%')) break
          }
          
          const text = container.innerText || ''
          
          // 提取 ROI（多种格式）
          const roiMatches = text.match(/(?:ROI|收益率)[:\s]*([+-]?\d+(?:,?\d+)*\.?\d*)%/gi) ||
                           text.match(/([+-]?\d+(?:,?\d+)*\.?\d*)%/g)
          let roi = null
          if (roiMatches && roiMatches.length > 0) {
            const roiStr = roiMatches[0].replace(/[^0-9.+-]/g, '')
            roi = parseFloat(roiStr)
          }
          
          // 提取昵称
          const nameEl = container.querySelector('[class*="name"], [class*="nick"], [class*="title"]')
          const nickname = nameEl?.innerText?.trim()?.split('\n')[0] || null
          
          // 提取头像
          const avatarEl = container.querySelector('img[src*="avatar"], img[src*="profile"], img[alt]')
          const avatar = avatarEl?.src || null
          
          // 提取 PnL
          const pnlMatch = text.match(/(?:PnL|Profit|盈亏|收益)[:\s]*\$?([+-]?\d+(?:,?\d+)*\.?\d*)\s*(K|M)?/i) ||
                          text.match(/\$([+-]?\d+(?:,?\d+)*\.?\d*)\s*(K|M)?/i)
          let pnl = null
          if (pnlMatch) {
            pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
            if (pnlMatch[2]?.toUpperCase() === 'K') pnl *= 1000
            if (pnlMatch[2]?.toUpperCase() === 'M') pnl *= 1000000
          }
          
          // 提取胜率
          const winRateMatch = text.match(/(?:Win Rate|Win|胜率)[:\s]*(\d+(?:\.\d+)?)%/i)
          const winRate = winRateMatch ? parseFloat(winRateMatch[1]) : null
          
          // 提取粉丝数/跟随者
          const followersMatch = text.match(/(\d+(?:,?\d+)*)\s*(?:Copiers|Followers|跟随|粉丝)/i)
          const followers = followersMatch ? parseInt(followersMatch[1].replace(/,/g, '')) : null
          
          // 提取最大回撤
          const mddMatch = text.match(/(?:MDD|Max Drawdown|Drawdown|回撤)[:\s]*([+-]?\d+(?:\.\d+)?)%/i)
          const maxDrawdown = mddMatch ? parseFloat(mddMatch[1]) : null

          if (traderId && roi !== null) {
            results.push({
              rank: idx + 1,
              traderId,
              nickname,
              avatar,
              profileUrl: href.startsWith('http') ? href : `https://www.binance.com${href}`,
              roi,
              pnl,
              winRate,
              followers,
              maxDrawdown,
            })
          }
        })
        
        return results
      })

      console.log(`  获取到 ${traders.length} 个交易员`)

      // 合并数据
      for (const trader of traders) {
        const key = trader.traderId
        const existing = allTraders.get(key) || {
          source: 'binance',
          traderId: trader.traderId,
          nickname: trader.nickname,
          avatar: trader.avatar,
          profileUrl: trader.profileUrl,
        }
        
        if (period.days === 7) {
          existing.roi_7d = trader.roi
          existing.pnl_7d = trader.pnl
          existing.winRate_7d = trader.winRate
        } else if (period.days === 30) {
          existing.roi_30d = trader.roi
          existing.pnl_30d = trader.pnl
          existing.winRate_30d = trader.winRate
        } else {
          existing.roi = trader.roi
          existing.pnl = trader.pnl
          existing.winRate = trader.winRate
          existing.rank = trader.rank
          existing.followers = trader.followers
          existing.maxDrawdown = trader.maxDrawdown
        }
        
        allTraders.set(key, existing)
      }

      await sleep(2000)
    }

    // 处理 API 拦截的数据
    if (apiResponses.length > 0) {
      console.log(`\n📡 处理 ${apiResponses.length} 个 API 响应...`)
      
      for (const response of apiResponses) {
        const list = response.data?.list || response.data?.data || response.data || []
        if (Array.isArray(list)) {
          console.log(`  处理 ${list.length} 个交易员数据`)
          
          list.forEach((item, idx) => {
            const traderId = item.portfolioId || item.encryptedUid || item.leadPortfolioId
            if (!traderId) return
            
            const existing = allTraders.get(String(traderId)) || {
              source: 'binance',
              traderId: String(traderId),
            }
            
            existing.nickname = existing.nickname || item.nickName || item.nickname
            existing.avatar = existing.avatar || item.userPhoto || item.avatar
            existing.roi = existing.roi ?? item.roi ?? item.roiPct
            existing.pnl = existing.pnl ?? item.pnl ?? item.profit
            existing.winRate = existing.winRate ?? item.winRate ?? item.winRatio
            existing.followers = existing.followers ?? item.copierCount ?? item.followerCount
            existing.maxDrawdown = existing.maxDrawdown ?? item.mdd ?? item.maxDrawdown
            existing.rank = existing.rank ?? (idx + 1)
            
            allTraders.set(String(traderId), existing)
          })
        }
      }
    }

    console.log(`\n📥 保存 ${allTraders.size} 个交易员数据...`)
    
    const capturedAt = new Date().toISOString()
    let saved = 0
    
    for (const [key, trader] of allTraders) {
      const result = await saveTrader(trader, capturedAt)
      if (result) saved++
    }
    
    console.log(`  ✓ 保存了 ${saved} 个交易员`)

    console.log('\n✅ 完成!')
    console.log('结束时间:', new Date().toISOString())

  } finally {
    await browser.close()
  }
}

async function saveTrader(trader, capturedAt) {
  try {
    // 保存 trader_sources
    await supabase.from('trader_sources').upsert({
      source: trader.source,
      source_type: 'leaderboard',
      source_trader_id: trader.traderId,
      handle: trader.nickname || null,
      profile_url: trader.avatar || null,
      is_active: true,
    }, { onConflict: 'source,source_trader_id' })

    // 为每个时间段创建独立的 snapshot 记录
    const periods = [
      { season_id: '7D', roi: trader.roi_7d, pnl: trader.pnl_7d, winRate: trader.winRate_7d, rank: null },
      { season_id: '30D', roi: trader.roi_30d, pnl: trader.pnl_30d, winRate: trader.winRate_30d, rank: null },
      { season_id: '90D', roi: trader.roi, pnl: trader.pnl, winRate: trader.winRate, rank: trader.rank },
    ]

    let savedAny = false
    for (const period of periods) {
      if (period.roi !== undefined && period.roi !== null) {
        await supabase.from('trader_snapshots').upsert({
          source: trader.source,
          source_trader_id: trader.traderId,
          season_id: period.season_id,
          rank: period.rank || null,
          roi: period.roi,
          pnl: period.pnl || null,
          win_rate: period.winRate || null,
          max_drawdown: trader.maxDrawdown || null,
          followers: trader.followers || 0,
          captured_at: capturedAt,
        }, { onConflict: 'source,source_trader_id,season_id,captured_at' })
        savedAny = true
      }
    }

    return savedAny
  } catch (error) {
    console.error(`  ✗ 保存失败 ${trader.traderId}: ${error.message}`)
    return false
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(console.error)
