#!/usr/bin/env node

/**
 * Bitget Copy Trading Scraper
 * 使用 Playwright 浏览器自动化获取 Bitget 交易员数据
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const BITGET_URLS = [
  'https://www.bitget.com/copy-trading/futures',
  'https://www.bitget.com/copy-trading/futures/elite-trader',
  'https://www.bitget.com/copy-trading/trader/list',
]
const TARGET_COUNT = 100

async function scrape() {
  console.log('🚀 Bitget Copy Trading Scraper')
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
    locale: 'zh-CN',
  })

  // 添加反检测脚本
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await context.newPage()
  const traders = new Map()
  const apiResponses = []

  // 拦截 API 响应 - 更广泛的匹配
  page.on('response', async (response) => {
    const url = response.url()
    const contentType = response.headers()['content-type'] || ''


    // 更广泛的匹配模式 - 聚焦于可能有交易员数据的端点
    const patterns = ['trace', 'trader', 'rank', 'leader', 'elite', 'top']
    const matched = patterns.some(p => url.toLowerCase().includes(p))

    if (matched && contentType.includes('json')) {
      try {
        const json = await response.json()
        const list = extractList(json, url)
        if (list.length > 0) {
          console.log(`  📡 拦截到 API 响应: ${list.length} 个交易员 from ${url.slice(0, 80)}...`)
          apiResponses.push(...list)
        }
      } catch {}
    }
  })

  // 访问多个页面收集数据
  for (const url of BITGET_URLS) {
    console.log(`\n📖 正在访问: ${url}`)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForTimeout(5000)
    } catch (e) {
      console.log('  ⚠️ 页面加载超时，继续处理...')
    }

    // 每个页面滚动几次
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800))
      await page.waitForTimeout(2000)
    }
  }

  await page.waitForTimeout(3000)

  // 滚动加载更多
  console.log('\n📜 最终滚动加载...')
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000))
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
    .sort((a, b) => (b.roi || 0) - (a.roi || 0))
    .slice(0, TARGET_COUNT)

  console.log(`\n💾 保存 ${traderList.length} 个交易员...`)

  const now = new Date().toISOString()
  const snapshots = traderList.map((t, idx) => ({
    source: 'bitget_futures',
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

function extractList(data, url = '') {
  if (!data) return []
  const results = []

  // 处理 topTraders 的嵌套结构: data.rows[].showColumnValue[]
  if (data?.data?.rows && Array.isArray(data.data.rows)) {
    for (const row of data.data.rows) {
      if (row.showColumnValue && Array.isArray(row.showColumnValue)) {
        results.push(...row.showColumnValue)
      }
    }
    if (results.length > 0) {
      console.log(`    ✅ 从 topTraders 提取 ${results.length} 个交易员`)
      return results
    }
  }

  // Bitget 特有的数据结构
  const paths = [
    data?.data?.traderList,
    data?.data?.traders,
    data?.data?.list,
    data?.data?.items,
    data?.data?.result,
    data?.result?.list,
    data?.result?.traderList,
    data?.list,
    data?.traderList,
  ]

  for (const list of paths) {
    if (Array.isArray(list) && list.length > 0) {
      // 检查第一个元素是否像交易员数据 (要有ROI或收益等字段)
      const first = list[0]
      if (first && (first.roiRate || first.yieldRate || first.profitRatio || first.curYieldRate || first.displayName)) {
        return list
      }
    }
  }

  return []
}

function parseTrader(item) {
  // Bitget topTraders 使用 displayName 作为唯一标识
  const handle = item.displayName || item.nickName || item.nickname ||
    item.traderName || item.name || null

  // 使用 displayName 或其他 ID 作为 trader_id
  const traderId = String(
    item.traderMemberId || item.traderUid || item.traderUserId ||
    item.traderId || item.uid || item.userId || item.memberId ||
    item.id || handle || ''
  )

  // 过滤无效 ID
  if (!traderId) return null
  const invalidIds = ['futures', 'spot', 'newcomer', 'achievement', 'expert', 'activity', 'holiday-themed', 'usd']
  if (invalidIds.includes(traderId.toLowerCase())) return null
  if (traderId.length < 10) return null // Bitget trader IDs are typically 20+ chars

  // 从 itemVoList 提取指标数据
  let roi = null
  let pnl = null
  let winRate = null
  let maxDrawdown = null

  if (item.itemVoList && Array.isArray(item.itemVoList)) {
    for (const metric of item.itemVoList) {
      const code = metric.showColumnCode
      const value = parseFloat(metric.comparedValue)

      if (code === 'profit_rate' || code === 'roi_rate') {
        roi = value
      } else if (code === 'total_income' || code === 'pnl') {
        pnl = value
      } else if (code === 'max_retracement' || code === 'max_drawdown') {
        maxDrawdown = Math.abs(value)
      } else if (code === 'total_winning_rate' || code === 'win_rate') {
        winRate = value
      }
    }
  }

  // 如果没有 itemVoList，尝试从直接字段提取
  if (roi === null) {
    roi = parseFloat(String(item.roiRate ?? item.roi ?? item.yieldRate ?? 0)) || null
    if (roi && Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100
  }
  if (pnl === null) {
    pnl = parseFloat(String(item.pnl ?? item.totalPnl ?? item.profit ?? 0)) || null
  }
  if (winRate === null) {
    winRate = parseFloat(String(item.winRate ?? item.winRatio ?? 0)) || null
    if (winRate && winRate > 0 && winRate <= 1) winRate *= 100
  }
  if (maxDrawdown === null) {
    maxDrawdown = parseFloat(String(item.maxDrawdown ?? item.mdd ?? 0)) || null
    if (maxDrawdown && maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
    if (maxDrawdown) maxDrawdown = Math.abs(maxDrawdown)
  }

  // 跟单人数
  const followers = parseInt(String(
    item.followCount ?? item.followerCount ?? item.copierCount ??
    item.followers ?? item.followingNum ?? item.copyTraderNum ?? 0
  ), 10)

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

    const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"]')

    cards.forEach((card) => {
      const text = card.innerText || ''
      if (text.length < 10) return

      const link = card.querySelector('a[href*="trader"], a[href*="copy"]')
      const href = link?.getAttribute('href') || ''
      const idMatch = href.match(/\/(\w+)$/) || href.match(/id=([^&]+)/)
      const traderId = idMatch?.[1] || `bitget_${Date.now()}_${results.length}`

      if (seen.has(traderId)) return
      seen.add(traderId)

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

      if (roi !== null && roi > 0) {
        results.push({
          source_trader_id: traderId,
          handle: null,
          roi,
          pnl: 0,
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
