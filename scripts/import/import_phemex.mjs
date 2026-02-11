/**
 * Phemex Copy Trading scraper (Playwright)
 *
 * URL: phemex.com/copy-trading/list
 * API: api10.phemex.com/phemex-lb/public/data/v3/user/recommend
 *   - pageNum=N, pageSize=100
 *   - CloudFront protected; need browser session
 *   - Fields: userId, nickName, avatar, pnlRate(decimal), pnl,
 *     followerCount, winRate, maxDrawdown
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
const PROXY = 'http://127.0.0.1:7890'

async function scrapeAllTraders() {
  console.log('Phemex: launching browser...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  // Intercept all recommend API responses
  const allTraders = new Map()
  let apiResponseSeen = false

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('user/recommend') && !url.includes('user/leaders')) return
    apiResponseSeen = true
    try {
      const json = await response.json().catch(() => null)
      if (!json) return
      const rows = json?.data?.rows || json?.data?.list || json?.data || []
      if (!Array.isArray(rows)) return
      for (const t of rows) {
        const id = String(t.userId || t.uid || '')
        if (!id || allTraders.has(id)) continue
        allTraders.set(id, parseTrader(t))
      }
    } catch {}
  })

  try {
    await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'domcontentloaded', timeout: 45000 })
    await sleep(8000)

    // Dismiss popups
    for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'I Agree']) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.count() > 0) await btn.first().click().catch(() => {})
    }
    await sleep(2000)
    console.log(`  Initial: ${allTraders.size} traders, API seen: ${apiResponseSeen}`)

    // Try in-page fetch for recommend API with pagination
    for (let pageNum = 1; pageNum <= 20; pageNum++) {
      const result = await page.evaluate(async (pn) => {
        try {
          const r = await fetch(`https://api10.phemex.com/phemex-lb/public/data/v3/user/recommend?hideFullyCopied=false&keyword=&pageNum=${pn}&pageSize=100`)
          return await r.json()
        } catch (e) { return { error: e.message } }
      }, pageNum)

      if (result?.error) {
        console.log(`  Page ${pageNum}: fetch error - ${result.error}`)
        // Try alternative: direct page navigation fetch
        break
      }

      const rows = result?.data?.rows || result?.data?.list || (Array.isArray(result?.data) ? result.data : [])
      if (!rows.length) {
        console.log(`  Page ${pageNum}: no data, response keys: ${Object.keys(result || {}).join(',')}`)
        if (result?.data) console.log(`    data keys: ${Object.keys(result.data).join(',')}`)
        break
      }

      let added = 0
      for (const t of rows) {
        const id = String(t.userId || t.uid || '')
        if (id && !allTraders.has(id)) { allTraders.set(id, parseTrader(t)); added++ }
      }
      console.log(`  Page ${pageNum}: +${added}, total ${allTraders.size}`)
      if (added === 0) break
      await sleep(500)
    }

    // If still low, try scrolling the page to trigger more API calls
    if (allTraders.size < 100) {
      console.log('  Trying scroll pagination...')
      for (let i = 0; i < 20; i++) {
        const before = allTraders.size
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(2000)
        // Also try clicking next/load more
        const nextBtn = page.locator('[class*="next"], [class*="load-more"], button:has-text("More")').first()
        if (await nextBtn.count() > 0) await nextBtn.click().catch(() => {})
        await sleep(1500)
        if (allTraders.size > before) console.log(`  Scroll ${i + 1}: ${allTraders.size} traders`)
        else if (i > 3) break
      }
    }

    // Also try the old leaders endpoint
    if (allTraders.size < 100) {
      console.log('  Trying leaders endpoint...')
      const result = await page.evaluate(async () => {
        try {
          const r = await fetch('https://api10.phemex.com/phemex-lb/public/data/user/leaders?pageSize=100&pageNo=1')
          return await r.json()
        } catch (e) { return { error: e.message } }
      })
      if (result?.data?.rows) {
        for (const t of result.data.rows) {
          const id = String(t.userId || '')
          if (id && !allTraders.has(id)) allTraders.set(id, parseTrader(t))
        }
        console.log(`  After leaders: ${allTraders.size} traders`)
      }
    }

    console.log(`  Total: ${allTraders.size} unique traders`)
  } catch (e) {
    console.error(`  Error: ${e.message}`)
  } finally {
    await browser.close()
  }

  return [...allTraders.values()]
}

function parseTrader(t) {
  const id = String(t.userId || t.uid || '')
  return {
    id,
    name: t.nickName || t.nickname || `Trader_${id.slice(0, 8)}`,
    avatar: t.avatar ? (t.avatar.startsWith('http') ? t.avatar : `https://static.phemex.com/avatar/${t.avatar}`) : null,
    // pnlRate is decimal (3.48 = 348%)
    pnl30d: parseFloat(String(t.pnl30d || t.pnl || 0)),
    roi30d: parseFloat(String(t.pnlRate30d || t.pnlRate || 0)) * 100,
    pnl90d: parseFloat(String(t.pnl90d || 0)),
    roi90d: parseFloat(String(t.pnlRate90d || 0)) * 100,
    pnl7d: parseFloat(String(t.pnl7d || 0)),
    roi7d: parseFloat(String(t.pnlRate7d || 0)) * 100,
    totalPnl: parseFloat(String(t.totalPnl || 0)),
    totalRoi: parseFloat(String(t.totalPnlRate || 0)) * 100,
    followers: parseInt(String(t.followerCount || 0)),
    winRate: t.winRate != null ? parseFloat(String(t.winRate)) : null,
    maxDrawdown: t.maxDrawdown != null ? Math.abs(parseFloat(String(t.maxDrawdown))) : null,
  }
}

async function saveTraders(traders, period) {
  if (!traders.length) { console.log(`  ⚠ ${period}: no data`); return 0 }

  const fieldMap = {
    '7D':  { pnl: 'pnl7d', roi: 'roi7d', fb_pnl: 'pnl30d', fb_roi: 'roi30d' },
    '30D': { pnl: 'pnl30d', roi: 'roi30d' },
    '90D': { pnl: 'pnl90d', roi: 'roi90d', fb_pnl: 'pnl30d', fb_roi: 'roi30d' },
  }
  const f = fieldMap[period]

  // Use primary fields, fallback if zero
  const getROI = (t) => {
    const v = t[f.roi]
    if (v) return v
    return f.fb_roi ? t[f.fb_roi] || 0 : 0
  }
  const getPNL = (t) => {
    const v = t[f.pnl]
    if (v) return v
    return f.fb_pnl ? t[f.fb_pnl] || 0 : 0
  }

  traders.sort((a, b) => getROI(b) - getROI(a))
  const now = new Date().toISOString()
  console.log(`\n💾 Saving ${traders.length} ${period} records...`)

  // Upsert sources
  for (let i = 0; i < traders.length; i += 30) {
    await supabase.from('trader_sources').upsert(
      traders.slice(i, i + 30).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
        profile_url: `https://phemex.com/copy-trading/trader/${t.id}`,
      })),
      { onConflict: 'source,source_trader_id' }
    )
  }

  let saved = 0
  for (let i = 0; i < traders.length; i += 30) {
    const batch = traders.slice(i, i + 30).map((t, j) => {
      const roi = getROI(t)
      const pnl = getPNL(t)
      const scores = calculateArenaScore(roi, pnl, t.maxDrawdown, t.winRate, period)
      return {
        source: SOURCE, source_trader_id: t.id, season_id: period,
        rank: i + j + 1, roi, pnl, followers: t.followers,
        win_rate: t.winRate, max_drawdown: t.maxDrawdown,
        arena_score: scores.totalScore, captured_at: now,
      }
    })
    const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
    if (!error) saved += batch.length
    else console.log(`  ⚠ upsert error: ${error.message}`)
  }
  console.log(`  ✅ Saved: ${saved}/${traders.length}`)
  return saved
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log(`Phemex scraper | Periods: ${periods.join(', ')}`)

  const traders = await scrapeAllTraders()
  if (!traders.length) { console.log('❌ No data'); process.exit(1) }

  let total = 0
  for (const p of periods) total += await saveTraders(traders, p)
  console.log(`\n✅ Phemex done: ${total} records saved`)
}

main().catch(e => { console.error(e); process.exit(1) })
