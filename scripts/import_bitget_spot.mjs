/**
 * Bitget Spot Copy Trading 排行榜数据抓取
 * 
 * 使用 Playwright 抓取 Bitget 现货跟单排行榜
 * 
 * 用法: node scripts/import_bitget_spot.mjs [7D|30D|90D]
 * 
 * 数据源: https://www.bitget.com/asia/copy-trading/spot
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

const SOURCE = 'bitget_spot'

const PERIOD_CONFIG = {
  '7D': { 
    url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=7',
    tabTexts: ['7天', '7D', '7 Days']
  },
  '30D': { 
    url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=30',
    tabTexts: ['30天', '30D', '30 Days']
  },
  '90D': { 
    url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=90',
    tabTexts: ['90天', '90D', '90 Days']
  },
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

async function fetchLeaderboardData(period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n=== 抓取 Bitget Spot ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log('URL:', config.url)

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
    })

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      window.chrome = { runtime: {} }
    })

    const page = await context.newPage()

    // 监听 API 响应
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy-trading') && (url.includes('ranking') || url.includes('list') || url.includes('spot'))) {
        try {
          const json = await response.json()
          const list = json.data?.list || json.data || json.list || []
          if (Array.isArray(list) && list.length > 0) {
            console.log(`  📡 拦截到 API: ${list.length} 条数据`)
            apiResponses.push({ url, list })
          }
        } catch (e) {}
      }
    })

    console.log('📱 访问页面...')
    try {
      await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    await sleep(5000)

    // 滚动加载更多
    console.log('📜 滚动加载更多数据...')
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(500)
    }
    await sleep(2000)

    // 处理 API 响应
    console.log(`\n📊 处理 ${apiResponses.length} 个 API 响应...`)
    for (const { list } of apiResponses) {
      list.forEach((item, idx) => {
        const traderId = String(item.traderId || item.uid || item.id || '')
        if (!traderId) return
        
        const roi = parseFloat(item.roi ?? item.roiRate ?? item.profit ?? 0)
        const existing = traders.get(traderId)
        
        if (!existing || roi > existing.roi) {
          traders.set(traderId, {
            traderId,
            nickname: item.nickName || item.nickname || item.name || null,
            avatar: item.avatar || item.avatarUrl || item.headUrl || null,
            roi,
            pnl: parseFloat(item.totalProfit ?? item.pnl ?? 0),
            winRate: parseFloat(item.winRate ?? item.winRatio ?? 0),
            maxDrawdown: parseFloat(item.mdd ?? item.maxDrawdown ?? 0),
            followers: parseInt(item.followerCount ?? item.followers ?? 0),
            rank: idx + 1,
          })
        }
      })
    }

    // 从 DOM 提取
    if (traders.size === 0) {
      console.log('📊 从页面 DOM 提取数据...')
      const pageTraders = await page.evaluate(() => {
        const results = []
        const seen = new Set()
        const links = document.querySelectorAll('a[href*="trader"], a[href*="copy-trading"]')
        links.forEach((link, idx) => {
          const href = link.getAttribute('href') || ''
          const idMatch = href.match(/trader\/(\w+)/) || href.match(/traderId=(\w+)/)
          const traderId = idMatch?.[1]
          if (!traderId || seen.has(traderId)) return
          seen.add(traderId)
          let container = link
          for (let i = 0; i < 8 && container.parentElement; i++) {
            container = container.parentElement
            if (container.innerText?.length > 100) break
          }
          const text = container.innerText || ''
          const roiMatches = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/g)
          let roi = null
          if (roiMatches) {
            for (const match of roiMatches) {
              const val = parseFloat(match.replace(/[^0-9.+-]/g, ''))
              if (val > 0 && (roi === null || val > roi)) roi = val
            }
          }
          let nickname = null
          const nameEl = container.querySelector('[class*="name"], [class*="nick"]')
          if (nameEl) nickname = nameEl.innerText?.trim()?.split('\n')[0]
          if (traderId && roi !== null) {
            results.push({ traderId, nickname, avatar: null, roi, pnl: null, winRate: null, maxDrawdown: null, followers: null, rank: results.length + 1 })
          }
        })
        return results
      })
      pageTraders.forEach(t => { if (!traders.has(t.traderId)) traders.set(t.traderId, t) })
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)

    if (traders.size === 0) {
      const screenshotPath = `/tmp/bitget_spot_${period}_${Date.now()}.png`
      await page.screenshot({ path: screenshotPath, fullPage: true })
      console.log(`  📸 截图保存到: ${screenshotPath}`)
    }
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
      await supabase.from('trader_sources').insert({
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

      if (error) errors++
      else saved++
    } catch (error) {
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
  console.log(`Bitget Spot Copy Trading 数据抓取`)
  console.log(`目标周期: ${period}`)
  console.log(`数据源: ${SOURCE}`)
  console.log(`========================================`)

  try {
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log('\n⚠ 未获取到任何数据')
      return
    }

    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    traders.forEach((t, idx) => t.rank = idx + 1)

    console.log(`\n📋 ${period} TOP 10:`)
    traders.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
    })

    const result = await saveTraders(traders, period)

    console.log(`\n✅ 完成！`)
    console.log(`   来源: ${SOURCE}`)
    console.log(`   周期: ${period}`)
    console.log(`   总数: ${traders.length}`)
    console.log(`   保存: ${result.saved}`)
    console.log(`   时间: ${new Date().toISOString()}`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
  }
}

main()
