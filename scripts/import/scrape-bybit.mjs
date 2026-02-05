#!/usr/bin/env node

/**
 * Bybit Copy Trading Scraper
 * 使用 Playwright 浏览器自动化获取 Bybit 交易员数据
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const BYBIT_URL = 'https://www.bybit.com/copyTrade/trade-center/find'
const TARGET_COUNT = 100

async function scrape() {
  console.log('🚀 Bybit Copy Trading Scraper')
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
    proxy: {
      server: 'http://127.0.0.1:7890',
    },
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

    // Bybit API 匹配模式
    const patterns = ['leaderDetails', 'leader-list', 'copyTrade', 'dynamic-leader', 'masterList']
    const matched = patterns.some(p => url.toLowerCase().includes(p.toLowerCase()))

    if (matched && contentType.includes('json')) {
      try {
        const json = await response.json()
        const list = extractList(json)
        if (list.length > 0) {
          console.log(`  📡 拦截到 API: ${list.length} 个交易员`)
          apiResponses.push(...list)
        }
      } catch {}
    }
  })

  console.log('\n📖 正在访问 Bybit...')
  try {
    await page.goto(BYBIT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  } catch (e) {
    console.log('  ⚠️ 页面加载超时，继续处理...')
  }

  await page.waitForTimeout(8000)

  // 滚动加载更多
  console.log('\n📜 滚动加载数据...')
  for (let i = 0; i < 15; i++) {
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

  // 从 DOM 提取
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
  const snapshots = traderList.map((t) => ({
    source: 'bybit',
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

  const { error } = await supabase
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

  const paths = [
    data?.result?.leaderDetails,
    data?.result?.list,
    data?.result?.rows,
    data?.data?.list,
    data?.data?.rows,
    data?.list,
    data?.data,
  ]

  for (const list of paths) {
    if (Array.isArray(list) && list.length > 0) {
      const first = list[0]
      if (first && (first.leaderMark || first.leaderId || first.uid || first.roi)) {
        return list
      }
    }
  }

  return []
}

function parseTrader(item) {
  const traderId = String(
    item.leaderMark || item.leaderId || item.uid || item.id || ''
  )

  if (!traderId || traderId.length < 5) return null

  const handle = item.nickName || item.nickname || item.displayName || item.name || null

  let roi = parseFloat(String(item.roi ?? item.roiValue ?? item.profitRate ?? 0))
  if (roi === 0) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  const pnl = parseFloat(String(item.pnl ?? item.totalProfit ?? item.profit ?? 0)) || null

  let winRate = parseFloat(String(item.winRate ?? item.winRatio ?? 0)) || null
  if (winRate && winRate > 0 && winRate <= 1) winRate *= 100

  let maxDrawdown = parseFloat(String(item.maxDrawdown ?? item.mdd ?? 0)) || null
  if (maxDrawdown && maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  if (maxDrawdown) maxDrawdown = Math.abs(maxDrawdown)

  const followers = parseInt(String(item.followerNum ?? item.followers ?? item.copierNum ?? 0), 10)

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

    const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="leader"]')

    cards.forEach((card) => {
      const text = card.innerText || ''
      if (text.length < 20) return

      const link = card.querySelector('a[href*="leader"], a[href*="trader"]')
      const href = link?.getAttribute('href') || ''
      const idMatch = href.match(/leaderMark=([^&]+)/) || href.match(/\/([A-Za-z0-9]+)$/)
      const traderId = idMatch?.[1]

      if (!traderId || seen.has(traderId)) return
      seen.add(traderId)

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
