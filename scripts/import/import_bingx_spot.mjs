/**
 * BingX Spot Copy Trading 排行榜数据抓取 (Playwright 浏览器版)
 *
 * BingX API 受 Cloudflare 保护，使用 Playwright 浏览器 + DOM 提取
 * URL: https://bingx.com/en/CopyTrading?type=spot
 *
 * 用法: node scripts/import/import_bingx_spot.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'bingx_spot'
const BASE_URL = 'https://bingx.com/en/CopyTrading?type=spot'
const TARGET_COUNT = 500

async function scrapeSpotTraders() {
  console.log('\n=== BingX Spot Copy Trading 抓取 ===')
  console.log('时间:', new Date().toISOString())

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  })

  const page = await context.newPage()
  const allTraders = new Map()

  // Intercept API responses
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy') && !url.includes('trader') && !url.includes('ranking')) return

    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      let list = []
      if (json?.data?.list && Array.isArray(json.data.list)) list = json.data.list
      else if (json?.data?.rows && Array.isArray(json.data.rows)) list = json.data.rows
      else if (json?.data?.records && Array.isArray(json.data.records)) list = json.data.records
      else if (Array.isArray(json?.data)) list = json.data

      if (list.length > 0) {
        console.log(`  📡 API 拦截: ${list.length} 条, URL: ${url.split('?')[0].split('/').slice(-3).join('/')}`)
        for (const t of list) {
          const traderId = String(t.uniqueId || t.uid || t.traderId || t.id || '')
          if (!traderId || traderId === 'undefined' || allTraders.has(traderId)) continue

          let roi = parseFloat(String(t.roi || t.roiRate || t.returnRate || t.pnlRatio || 0))
          if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

          allTraders.set(traderId, {
            traderId,
            nickname: t.traderName || t.nickname || t.nickName || t.displayName || t.name || `Trader_${traderId.slice(0, 8)}`,
            avatarUrl: t.headUrl || t.avatar || t.avatarUrl || null,
            roi,
            pnl: parseFloat(String(t.pnl || t.totalPnl || t.profit || t.cumulativePnl || 0)),
            winRate: t.winRate != null ? parseFloat(String(t.winRate)) * (parseFloat(String(t.winRate)) <= 1 ? 100 : 1) : null,
            maxDrawdown: t.maxDrawdown != null ? parseFloat(String(t.maxDrawdown)) * (parseFloat(String(t.maxDrawdown)) <= 1 ? 100 : 1) : null,
            followers: parseInt(String(t.followerNum || t.followers || t.followerCount || t.copyNum || 0)),
            tradesCount: parseInt(String(t.tradeCount || t.orderCount || 0)) || null,
          })
        }
        console.log(`    累计: ${allTraders.size}`)
      }
    } catch { /* ignore */ }
  })

  try {
    console.log(`  导航到 ${BASE_URL}...`)
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {
      console.log('  ⚠ 页面加载超时，继续...')
    })
    await sleep(5000)

    // Close popups
    for (const text of ['OK', 'Got it', 'Accept', 'Close', 'I understand', 'Confirm']) {
      const btn = page.locator(`button:has-text("${text}")`).first()
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click().catch(() => {})
        await sleep(500)
      }
    }

    // Ensure we're on the Spot tab
    const spotTab = page.locator('span.bx-tab-item-label-link:has-text("Spot")').first()
    if (await spotTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await spotTab.click()
      await sleep(3000)
    }

    console.log('  开始从 DOM 提取交易员数据...')

    // Extract from DOM page by page
    let maxPages = 20
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const pageTraders = await page.evaluate(() => {
        const traders = []
        // Find all trader cards in the leaderboard
        const cards = document.querySelectorAll('[class*=trader-card], [class*=traderCard], [class*=card-item]')

        for (const card of cards) {
          const text = card.innerText || ''
          if (!text.includes('Spot')) continue

          // Extract name - usually the first line
          const lines = text.split('\n').map(l => l.trim()).filter(l => l)
          const name = lines[0] || ''

          // Extract PnL percentage
          const pnlMatch = text.match(/profit and loss\s*\n?\s*([+-]?\d+\.?\d*)%/i) ||
                          text.match(/([+-]?\d+\.?\d*)%/i)
          const roi = pnlMatch ? parseFloat(pnlMatch[1]) : null

          // Extract win ratio
          const wrMatch = text.match(/Win Ratio\s*\n?\s*(\d+\.?\d*)%/i)
          const winRate = wrMatch ? parseFloat(wrMatch[1]) : null

          // Extract cumulative PnL
          const pnlAbsMatch = text.match(/Cumulative PnL\s*\n?\s*([+-]?\d[\d,.]*)/i)
          const pnl = pnlAbsMatch ? parseFloat(pnlAbsMatch[1].replace(/,/g, '')) : null

          // Extract copiers/followers
          const followerMatch = text.match(/(\d+)\s*\/\s*\d+/)
          const followers = followerMatch ? parseInt(followerMatch[1]) : 0

          // Extract copy trading days
          const daysMatch = text.match(/Copy Trading days\s*\n?\s*(\d+)/i)
          const days = daysMatch ? parseInt(daysMatch[1]) : null

          if (name && name !== 'Spot') {
            traders.push({ name, roi, winRate, pnl, followers, days })
          }
        }

        // Also try the list/table format
        if (traders.length === 0) {
          const listItems = document.querySelectorAll('[class*=list] [class*=item], [class*=trader-list] > div')
          for (const item of listItems) {
            const text = item.innerText || ''
            if (!text.includes('Spot') && !text.includes('Win Ratio')) continue

            const lines = text.split('\n').map(l => l.trim()).filter(l => l)
            const name = lines.find(l => !l.includes('%') && !l.includes('/') && !l.includes('Spot') && !l.includes('Win') && !l.includes('PnL') && !l.includes('Copy') && !l.includes('Full') && l.length > 1 && l.length < 40) || ''

            const roiMatch = text.match(/([+-]?\d+\.?\d*)%/)
            const roi = roiMatch ? parseFloat(roiMatch[1]) : null

            const wrMatch = text.match(/Win Ratio\s*\n?\s*(\d+\.?\d*)%/i)
            const winRate = wrMatch ? parseFloat(wrMatch[1]) : null

            const pnlMatch = text.match(/Cumulative PnL\s*\n?\s*([+-]?\d[\d,.]*)/i)
            const pnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, '')) : null

            const followerMatch = text.match(/(\d+)\s*\/\s*\d+/)
            const followers = followerMatch ? parseInt(followerMatch[1]) : 0

            if (name) {
              traders.push({ name, roi, winRate, pnl, followers })
            }
          }
        }

        return traders
      })

      for (const t of pageTraders) {
        const key = t.name
        if (!allTraders.has(key)) {
          allTraders.set(key, {
            traderId: key.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50),
            nickname: t.name,
            avatarUrl: null,
            roi: t.roi,
            pnl: t.pnl || 0,
            winRate: t.winRate,
            maxDrawdown: null,
            followers: t.followers || 0,
            tradesCount: null,
          })
        }
      }

      console.log(`  第 ${pageNum} 页: DOM提取 ${pageTraders.length} 个, 累计 ${allTraders.size}`)

      if (allTraders.size >= TARGET_COUNT) break

      // Navigate to next page
      const nextPage = page.locator(`.page-cell:has-text("${pageNum + 1}")`).first()
      if (await nextPage.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextPage.click()
        await sleep(3000)
      } else {
        console.log(`  ℹ 无更多页面`)
        break
      }
    }

    await browser.close()
    console.log(`\n📊 共获取 ${allTraders.size} 个交易员`)
    return Array.from(allTraders.values())
  } catch (e) {
    console.error('  Error:', e.message)
    await browser.close()
    return Array.from(allTraders.values())
  }
}

async function saveTraders(traders, period) {
  if (traders.length === 0) return { saved: 0, errors: 0 }

  // Filter: must have ROI
  const valid = traders.filter(t => t.roi !== null && t.roi !== undefined)
  valid.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const topTraders = valid.slice(0, TARGET_COUNT)
  topTraders.forEach((t, idx) => t.rank = idx + 1)

  console.log(`\n💾 保存 ${topTraders.length} 个交易员 (${SOURCE} - ${period})`)
  console.log(`\n📋 TOP 10:`)
  topTraders.slice(0, 10).forEach((t, idx) => {
    console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
  })

  const capturedAt = new Date().toISOString()
  let saved = 0, errors = 0

  for (const t of topTraders) {
    try {
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: t.traderId,
        handle: t.nickname,
        avatar_url: t.avatarUrl || null,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const scores = calculateArenaScore(t.roi || 0, t.pnl || 0, t.maxDrawdown || null, t.winRate || null, period)

      const { error } = await supabase.from('trader_snapshots').upsert({
        source: SOURCE,
        source_trader_id: t.traderId,
        season_id: period,
        rank: t.rank,
        roi: t.roi || 0,
        pnl: t.pnl || 0,
        win_rate: t.winRate || null,
        max_drawdown: t.maxDrawdown || null,
        followers: t.followers || 0,
        trades_count: t.tradesCount || null,
        arena_score: scores.totalScore,
        captured_at: capturedAt,
      }, { onConflict: 'source,source_trader_id,season_id' })

      if (error) { errors++; } else { saved++; }
    } catch (e) {
      errors++
    }
  }

  console.log(`  ✅ 保存: ${saved}, 失败: ${errors}`)
  return { saved, errors }
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  const totalStart = Date.now()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`BingX Spot Copy Trading 数据抓取`)
  console.log(`周期: ${periods.join(', ')}`)
  console.log(`数据源: ${SOURCE}`)
  console.log(`${'='.repeat(50)}`)

  // BingX spot page doesn't have period tabs visible in the same way
  // The data shown is cumulative/overall - we use the same scrape for all periods
  const traders = await scrapeSpotTraders()

  if (traders.length === 0) {
    console.log('❌ 未获取到数据')
    process.exit(1)
  }

  const results = []
  for (const period of periods) {
    const result = await saveTraders(traders, period)
    results.push({ period, saved: result.saved })
  }

  const elapsed = ((Date.now() - totalStart) / 1000).toFixed(1)
  console.log(`\n${'='.repeat(50)}`)
  console.log(`✅ 完成！`)
  for (const r of results) {
    console.log(`  ${r.period}: ${r.saved} 条`)
  }
  console.log(`  耗时: ${elapsed}s`)
  console.log(`${'='.repeat(50)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
