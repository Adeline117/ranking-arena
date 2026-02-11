/**
 * Phemex 合约跟单排行榜数据抓取 (Playwright 浏览器版)
 *
 * API: api10.phemex.com/phemex-lb/public/data/user/leaders
 *   - pageNum/pageSize=10, sortBy=Pnl30d
 *   - Total ~50 traders on platform
 *   - CloudFront WAF blocks direct curl; must use browser context
 *
 * Strategy:
 *   1. Navigate to leaderboard page to establish browser session
 *   2. Intercept API responses as page navigates through pages
 *   3. Click [class*=next] button to paginate
 *   4. Try different sort tabs (ROI, PnL, Copiers) to get more unique traders
 *
 * Usage: node scripts/import/import_phemex.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'phemex'
const TARGET_COUNT = 500
const LEADERBOARD_URL = 'https://phemex.com/copy-trading/leaderboard'

async function scrapeAllTraders() {
  console.log('\n📋 Phemex: 启动浏览器抓取...')

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
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
    try {
      const url = response.url()
      if (!url.includes('phemex-lb/public/data/user/leaders')) return
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return

      const json = await response.json().catch(() => null)
      if (!json) return
      const rows = json?.data?.rows || []

      for (const t of rows) {
        const traderId = String(t.userId || '')
        if (!traderId || allTraders.has(traderId)) continue

        // Parse PnL fields - Phemex uses E8 scaling for some values
        const parsePnl = (v) => {
          let n = parseFloat(String(v || 0))
          if (Math.abs(n) > 1e7) n = n / 1e8
          return n
        }

        const parseRate = (v) => {
          let n = parseFloat(String(v || 0))
          if (Math.abs(n) <= 10) n *= 100 // decimal to percent
          return n
        }

        allTraders.set(traderId, {
          traderId,
          nickname: t.nickName || `Trader_${traderId.slice(0, 8)}`,
          avatar: t.avatar || null,
          // Multiple PnL fields for different periods
          pnl7d: parsePnl(t.pnl7d),
          pnlRate7d: parseRate(t.pnlRate7d),
          pnl30d: parsePnl(t.pnl30d),
          pnlRate30d: parseRate(t.pnlRate30d),
          pnl90d: parsePnl(t.pnl90d),
          pnlRate90d: parseRate(t.pnlRate90d),
          totalPnl: parsePnl(t.totalPnl),
          totalPnlRate: parseRate(t.totalPnlRate),
          followers: parseInt(String(t.followerCount || t.copierCount || 0)),
          ranking: t.ranking || 0,
        })
      }
    } catch {}
  })

  try {
    // Navigate to leaderboard
    console.log(`  导航到 ${LEADERBOARD_URL}...`)
    await page.goto(LEADERBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {
      console.log('  ⚠ 导航超时，继续...')
    })
    await sleep(8000)

    // Close popups
    for (const text of ['OK', 'Got it', 'Accept', 'Close', 'I understand', 'Confirm', 'I Agree']) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.count() > 0) await btn.first().click().catch(() => {})
    }
    await page.evaluate(() => {
      document.querySelectorAll('[class*="modal"] [class*="close"], [class*="dialog"] [class*="close"]')
        .forEach(el => { try { el.click() } catch {} })
    }).catch(() => {})
    await sleep(2000)

    console.log(`  初始加载: ${allTraders.size} traders`)

    // Paginate through all pages
    async function paginateAll() {
      for (let i = 0; i < 10; i++) {
        const nextBtn = page.locator('[class*="next"]').first()
        if (await nextBtn.count() > 0) {
          const before = allTraders.size
          await nextBtn.click().catch(() => {})
          await sleep(2500)
          if (allTraders.size === before) {
            // Wait a bit more
            await sleep(1500)
            if (allTraders.size === before) break
          }
        } else break
      }
    }

    await paginateAll()
    console.log(`  默认排序后: ${allTraders.size} traders`)

    // Try different sort tabs to get more unique traders
    const sortTexts = ['ROI', 'Win Rate', 'Copiers', 'AUM']
    for (const txt of sortTexts) {
      try {
        const el = page.getByText(txt, { exact: true })
        if (await el.count() > 0) {
          await el.first().click()
          await sleep(3000)
          await paginateAll()
          console.log(`  排序 "${txt}" 后: ${allTraders.size} traders`)
        }
      } catch {}
    }

    // Try period tabs
    for (const pt of ['7D', '7 Days', '30D', '30 Days', '90D', '90 Days']) {
      try {
        const el = page.getByText(pt, { exact: true })
        if (await el.count() > 0) {
          await el.first().click()
          await sleep(3000)
          await paginateAll()
          console.log(`  周期 "${pt}" 后: ${allTraders.size} traders`)
        }
      } catch {}
    }

    console.log(`\n  📊 总计抓取: ${allTraders.size} 个unique traders`)

  } catch (e) {
    console.error(`  ❌ Error: ${e.message}`)
  } finally {
    await browser.close()
  }

  return [...allTraders.values()]
}

async function saveTraders(traders, period) {
  if (traders.length === 0) {
    console.log(`  ⚠ ${period}: 无数据可保存`)
    return 0
  }

  // Map period to Phemex data fields
  const periodFields = {
    '7D': { pnl: 'pnl7d', roi: 'pnlRate7d' },
    '30D': { pnl: 'pnl30d', roi: 'pnlRate30d' },
    '90D': { pnl: 'pnl90d', roi: 'pnlRate90d' },
  }
  const fields = periodFields[period] || periodFields['30D']

  // Sort by ROI for this period
  traders.sort((a, b) => (b[fields.roi] || 0) - (a[fields.roi] || 0))
  const topTraders = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()

  console.log(`\n💾 保存 ${topTraders.length} 条 ${period} 数据...`)

  // Save trader_sources
  const sourcesData = topTraders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar,
    profile_url: `https://phemex.com/copy-trading/trader/${t.traderId}`,
    is_active: true,
  }))

  for (let i = 0; i < sourcesData.length; i += 30) {
    await supabase.from('trader_sources').upsert(
      sourcesData.slice(i, i + 30),
      { onConflict: 'source,source_trader_id' }
    )
  }

  // Save snapshots
  const snapshots = topTraders.map((t, idx) => {
    const roi = t[fields.roi] || 0
    const pnl = t[fields.pnl] || 0
    const scores = calculateArenaScore(roi, pnl, null, null, period)

    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi,
      pnl,
      win_rate: null,
      max_drawdown: null,
      followers: t.followers,
      arena_score: scores.totalScore,
      handle: t.nickname,
      avatar_url: t.avatar,
      captured_at: capturedAt,
    }
  })

  let saved = 0
  for (let i = 0; i < snapshots.length; i += 30) {
    const batch = snapshots.slice(i, i + 30)
    const { error } = await supabase.from('trader_snapshots').upsert(batch, {
      onConflict: 'source,source_trader_id,season_id'
    })
    if (!error) saved += batch.length
    else console.log(`  ⚠ batch upsert error: ${error.message}`)
  }

  console.log(`  ✅ 保存成功: ${saved}/${topTraders.length}`)
  return saved
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('Phemex 数据抓取开始 (Playwright 浏览器模式)...')
  console.log(`周期: ${periods.join(', ')}`)

  // Scrape once - get all traders with all period data
  const traders = await scrapeAllTraders()

  if (traders.length === 0) {
    console.log('\n❌ 未获取到任何trader数据')
    return
  }

  let totalSaved = 0
  for (const period of periods) {
    const saved = await saveTraders(traders, period)
    totalSaved += saved
    if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
  }

  console.log(`\n✅ Phemex 完成，共保存 ${totalSaved} 条记录`)
}

main().catch(e => { console.error(e); process.exit(1) })
