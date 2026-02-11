/**
 * Phemex Copy Trading leaderboard scraper (Playwright)
 *
 * API: api10.phemex.com/phemex-lb/public/data/user/leaders
 *   - 10 per page (WAF blocks direct fetch; must intercept browser responses)
 *   - total ~50 traders
 *   - No 7D fields; only 30D and 90D PnL/ROI available
 *   - pnlRate values are decimal (3.48 = 348%)
 *
 * Strategy: load leaderboard page, intercept API responses while paginating
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
  const allTraders = new Map()

  // Intercept leader API responses
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('phemex-lb/public/data/user/leaders')) return
    try {
      const json = await response.json().catch(() => null)
      if (!json?.data?.rows) return
      for (const t of json.data.rows) {
        const id = String(t.userId || '')
        if (!id || allTraders.has(id)) continue
        allTraders.set(id, {
          id,
          name: t.nickName || `Trader_${id.slice(0, 8)}`,
          avatar: t.avatar ? `https://static.phemex.com/avatar/${t.avatar}` : null,
          pnl30d: parseFloat(String(t.pnl30d || 0)),
          roi30d: parseFloat(String(t.pnlRate30d || 0)) * 100,
          pnl90d: parseFloat(String(t.pnl90d || 0)),
          roi90d: parseFloat(String(t.pnlRate90d || 0)) * 100,
          totalPnl: parseFloat(String(t.totalPnl || 0)),
          totalRoi: parseFloat(String(t.totalPnlRate || 0)) * 100,
          followers: parseInt(String(t.followerCount || 0)),
        })
      }
    } catch {}
  })

  try {
    await page.goto('https://phemex.com/copy-trading/leaderboard', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await sleep(8000)

    // Dismiss popups
    for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'I Agree']) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.count() > 0) await btn.first().click().catch(() => {})
    }
    await sleep(2000)
    console.log(`  Initial: ${allTraders.size} traders`)

    // Paginate
    for (let i = 0; i < 10; i++) {
      const before = allTraders.size
      const nextBtn = page.locator('[class*="next"]').first()
      if (await nextBtn.count() === 0) break
      await nextBtn.click().catch(() => {})
      await sleep(3000)
      console.log(`  Page ${i + 2}: ${allTraders.size} traders`)
      if (allTraders.size === before) break
    }

    console.log(`  Total: ${allTraders.size} unique traders`)
  } catch (e) {
    console.error(`  Error: ${e.message}`)
  } finally {
    await browser.close()
  }

  return [...allTraders.values()]
}

async function saveTraders(traders, period) {
  if (!traders.length) { console.log(`  ⚠ ${period}: no data`); return 0 }

  // Map period to fields - no 7D available, use 30D as fallback
  const fieldMap = {
    '7D':  { pnl: 'pnl30d', roi: 'roi30d' },  // fallback
    '30D': { pnl: 'pnl30d', roi: 'roi30d' },
    '90D': { pnl: 'pnl90d', roi: 'roi90d' },
  }
  const f = fieldMap[period]
  traders.sort((a, b) => (b[f.roi] || 0) - (a[f.roi] || 0))

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

  // Upsert snapshots
  let saved = 0
  for (let i = 0; i < traders.length; i += 30) {
    const batch = traders.slice(i, i + 30).map((t, j) => {
      const roi = t[f.roi] || 0
      const pnl = t[f.pnl] || 0
      const scores = calculateArenaScore(roi, pnl, null, null, period)
      return {
        source: SOURCE, source_trader_id: t.id, season_id: period,
        rank: i + j + 1, roi, pnl, followers: t.followers,
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
  if (!traders.length) { console.log('❌ No data'); return }

  let total = 0
  for (const p of periods) total += await saveTraders(traders, p)
  console.log(`\n✅ Phemex done: ${total} records saved`)
}

main().catch(e => { console.error(e); process.exit(1) })
