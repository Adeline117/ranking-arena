#!/usr/bin/env node

/**
 * BingX Copy Trading Scraper
 * 使用 Playwright 浏览器自动化获取 BingX 交易员数据
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { chromium } from 'playwright'
import { sb } from './lib/index.mjs'

const BINGX_URL = 'https://bingx.com/en/CopyTrading/leaderBoard'
const TARGET_COUNT = 100

async function scrape() {
  console.log('🚀 BingX Copy Trading Scraper')
  console.log('='.repeat(50))

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await context.newPage()
  const traders = new Map()
  const apiResponses = []

  // 拦截 API 响应
  page.on('response', async (response) => {
    const url = response.url()
    const contentType = response.headers()['content-type'] || ''

    // BingX API 匹配模式
    const patterns = ['topRanking', 'trader/list', 'leaderboard', 'ranking', 'copy']
    const matched = patterns.some(p => url.toLowerCase().includes(p.toLowerCase()))

    if (matched && contentType.includes('json')) {
      try {
        const json = await response.json()
        const list = extractList(json)
        if (list.length > 0) {
          console.log(`  📡 拦截到 API: ${list.length} 个交易员 from ${url.slice(0, 80)}...`)
          apiResponses.push(...list)
        }
      } catch {}
    }
  })

  console.log('\n📖 正在访问 BingX...')
  try {
    await page.goto(BINGX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  } catch (e) {
    console.log('  ⚠️ 页面加载超时，继续处理...')
  }

  await page.waitForTimeout(8000)

  // 尝试切换不同的排行榜类型
  console.log('\n📜 切换排行榜类型...')
  try {
    // 点击 30D 选项
    const tabs = await page.$$('[class*="tab"], [class*="period"], [role="tab"]')
    for (const tab of tabs) {
      const text = await tab.textContent()
      if (text?.includes('30') || text?.includes('ROI')) {
        await tab.click()
        await page.waitForTimeout(3000)
        break
      }
    }
  } catch {}

  // 滚动加载更多
  console.log('\n📜 滚动加载数据...')
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 800))
    await page.waitForTimeout(2000)

    // 处理拦截到的数据
    for (const item of apiResponses) {
      const trader = parseTrader(item)
      if (trader && !traders.has(trader.source_trader_id)) {
        traders.set(trader.source_trader_id, trader)
      }
    }

    console.log(`  第 ${i + 1} 次滚动: 已收集 ${traders.size} 个交易员`)

    if (traders.size >= TARGET_COUNT) break
  }

  // 如果 API 拦截不够，从 DOM 提取
  if (traders.size < 20) {
    console.log('\n🔍 从 DOM 提取数据...')
    const domTraders = await extractFromDom(page)
    for (const t of domTraders) {
      if (!traders.has(t.source_trader_id)) {
        traders.set(t.source_trader_id, t)
      }
    }
    console.log(`  从 DOM 提取: ${domTraders.length} 个交易员`)
  }

  await browser.close()

  // 保存到数据库
  const traderList = Array.from(traders.values())
    .filter(t => t.roi !== null && t.roi !== 0)
    .sort((a, b) => (b.roi || 0) - (a.roi || 0))
    .slice(0, TARGET_COUNT)

  console.log(`\n💾 保存 ${traderList.length} 个交易员...`)

  if (traderList.length === 0) {
    console.log('  ⚠️ 没有获取到有效数据')
    return
  }

  const now = new Date().toISOString()
  const snapshots = traderList.map((t, idx) => ({
    source: 'bingx',
    source_trader_id: t.source_trader_id,
    season_id: '30D',
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.win_rate,
    max_drawdown: t.max_drawdown,
    followers: t.followers,
    arena_score: calculateArenaScore(t),
    captured_at: now,
  }))

  const { error } = await sb
    .from('trader_snapshots')
    .upsert(snapshots, { onConflict: 'source,source_trader_id,season_id' })

  if (error) {
    console.log(`  ❌ 保存失败: ${error.message}`)
  } else {
    console.log(`  ✅ 成功保存 ${snapshots.length} 条记录`)
  }

  console.log('\n' + '='.repeat(50))
  console.log('📊 完成!')
}

function extractList(data) {
  if (!data) return []

  // BingX 数据结构
  const paths = [
    data?.data?.list,
    data?.data?.rows,
    data?.data?.records,
    data?.data?.traders,
    data?.result?.list,
    data?.result?.rows,
    data?.data,
    data?.list,
  ]

  for (const list of paths) {
    if (Array.isArray(list) && list.length > 0) {
      // 验证是否是交易员数据
      const first = list[0]
      if (first && (first.uniqueId || first.uid || first.traderId || first.roi || first.roiRate)) {
        return list
      }
    }
  }

  return []
}

function parseTrader(item) {
  // BingX trader ID 字段
  const traderId = String(
    item.uniqueId || item.uid || item.traderId || item.id || ''
  )

  // 过滤无效 ID (货币代码等)
  if (!traderId || traderId.length < 5) return null
  if (/^[A-Z]{3,4}$/.test(traderId)) return null // 货币代码

  const handle = item.traderName || item.nickname || item.nickName ||
    item.displayName || item.name || null

  // ROI 处理
  let roi = parseFloat(String(item.roi ?? item.roiRate ?? item.returnRate ?? item.pnlRatio ?? 0))
  if (roi === 0) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  // PNL
  const pnl = parseFloat(String(item.pnl ?? item.totalPnl ?? item.profit ?? 0)) || null

  // 胜率
  let winRate = parseFloat(String(item.winRate ?? 0)) || null
  if (winRate && winRate > 0 && winRate <= 1) winRate *= 100

  // 最大回撤
  let maxDrawdown = parseFloat(String(item.maxDrawdown ?? 0)) || null
  if (maxDrawdown && maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  if (maxDrawdown) maxDrawdown = Math.abs(maxDrawdown)

  // 跟单人数
  const followers = parseInt(String(item.followerNum ?? item.followers ?? item.followerCount ?? 0), 10)

  return {
    source_trader_id: traderId,
    handle,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers,
  }
}

async function extractFromDom(page) {
  return await page.evaluate(() => {
    const results = []
    const seen = new Set()

    // BingX 交易员卡片选择器
    const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], [class*="leader"]')

    cards.forEach((card) => {
      const text = card.innerText || ''
      if (text.length < 20) return

      // 尝试从链接获取 ID
      const link = card.querySelector('a[href*="trader"], a[href*="detail"]')
      const href = link?.getAttribute('href') || ''
      const idMatch = href.match(/\/(\d+)$/) || href.match(/id=(\d+)/)
      const traderId = idMatch?.[1]

      if (!traderId || seen.has(traderId)) return
      seen.add(traderId)

      // 提取 ROI
      const roiMatches = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/g)
      let roi = null
      if (roiMatches) {
        for (const match of roiMatches) {
          const val = parseFloat(match.replace(/[^0-9.+-]/g, ''))
          if (Math.abs(val) > 1 && (roi === null || Math.abs(val) > Math.abs(roi))) {
            roi = val
          }
        }
      }

      if (roi !== null && roi !== 0) {
        results.push({
          source_trader_id: traderId,
          handle: null,
          roi,
          pnl: null,
          win_rate: null,
          max_drawdown: null,
          followers: 0,
        })
      }
    })

    return results
  })
}

function calculateArenaScore(t) {
  const roiScore = Math.min(100, Math.max(0, (t.roi || 0) / 10))
  const wrScore = (t.win_rate || 50) * 0.5
  const ddPenalty = Math.min(30, (t.max_drawdown || 0) * 0.3)
  return Math.round(roiScore * 0.6 + wrScore * 0.3 - ddPenalty)
}

scrape().catch(console.error)
