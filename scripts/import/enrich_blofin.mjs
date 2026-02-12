/**
 * BloFin Enrichment Script
 * 
 * Fetches win_rate and trades_count for existing BloFin traders
 * Uses /uapi/v1/copy/trader/info and /uapi/v1/copy/trader/order/history
 * Must run from browser context (Cloudflare protected)
 *
 * Usage: node scripts/import/enrich_blofin.mjs
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'blofin'

async function main() {
  // 1. Get all blofin traders needing enrichment
  const { data: traders, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, roi, pnl, max_drawdown, win_rate, trades_count')
    .eq('source', SOURCE)
    .is('win_rate', null)

  if (error) { console.error('DB error:', error.message); process.exit(1) }
  if (!traders?.length) { console.log('No traders need enrichment'); return }

  // Dedupe by source_trader_id (one API call per trader, update all seasons)
  const uniqueIds = [...new Set(traders.map(t => t.source_trader_id))]
  console.log(`Found ${traders.length} rows (${uniqueIds.length} unique traders) needing enrichment`)

  // 2. Launch browser, go to leaderboard to establish session
  console.log('Launching browser...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await ctx.newPage()

  await page.goto('https://www.blofin.com/copy-trade?tab=leaderboard&module=futures', {
    timeout: 45000, waitUntil: 'domcontentloaded'
  })
  await sleep(8000)
  console.log('Page loaded:', await page.title())

  // 3. Fetch info for each trader
  const enriched = new Map() // uid -> { win_rate, trades_count }
  let success = 0, failed = 0

  for (let i = 0; i < uniqueIds.length; i++) {
    const uid = uniqueIds[i]
    try {
      // Get trader info (win_rate, max_draw_down)
      const info = await page.evaluate(async (uid) => {
        const r = await fetch('/uapi/v1/copy/trader/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid }),
        })
        return await r.json()
      }, uid)

      if (info?.code !== 200 || !info.data) {
        console.log(`  ⚠ ${uid}: info failed (${info?.msg || 'unknown'})`)
        failed++
        await sleep(500)
        continue
      }

      const d = info.data
      const winRate = d.win_rate != null ? parseFloat(d.win_rate) * 100 : null
      const mdd = d.max_draw_down != null ? Math.abs(parseFloat(d.max_draw_down)) * 100 : null

      // Get trade count from order history
      let tradesCount = null
      try {
        const history = await page.evaluate(async (uid) => {
          // Fetch multiple pages to count
          let total = 0
          for (let pg = 1; pg <= 10; pg++) {
            const r = await fetch('/uapi/v1/copy/trader/order/history', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uid, page: pg, pageSize: 100 }),
            })
            const j = await r.json()
            if (j?.code !== 200 || !Array.isArray(j.data) || j.data.length === 0) break
            total += j.data.length
            if (j.data.length < 100) break
          }
          return total
        }, uid)
        if (history > 0) tradesCount = history
      } catch {}

      enriched.set(uid, { winRate, mdd, tradesCount })
      success++
      if ((i + 1) % 10 === 0 || i === uniqueIds.length - 1) {
        console.log(`  Progress: ${i + 1}/${uniqueIds.length} (${success} ok, ${failed} failed)`)
      }
    } catch (e) {
      console.log(`  ⚠ ${uid}: error - ${e.message}`)
      failed++
    }
    await sleep(300 + Math.random() * 200)
  }

  await browser.close()
  console.log(`\nFetched: ${enriched.size} traders enriched`)

  // 4. Update DB
  let updated = 0
  for (const t of traders) {
    const data = enriched.get(t.source_trader_id)
    if (!data) continue

    const updates = {}
    if (data.winRate != null) updates.win_rate = data.winRate
    if (data.mdd != null) updates.max_drawdown = data.mdd
    if (data.tradesCount != null) updates.trades_count = data.tradesCount

    if (Object.keys(updates).length === 0) continue

    // Recalculate arena score
    const roi = parseFloat(t.roi || 0)
    const pnl = parseFloat(t.pnl || 0)
    const mdd = data.mdd != null ? data.mdd : (t.max_drawdown != null ? parseFloat(t.max_drawdown) : null)
    const wr = data.winRate
    const scores = calculateArenaScore(roi, pnl, mdd, wr, t.season_id)
    updates.arena_score = scores.totalScore

    const { error } = await supabase
      .from('trader_snapshots')
      .update(updates)
      .eq('source', SOURCE)
      .eq('source_trader_id', t.source_trader_id)
      .eq('season_id', t.season_id)

    if (error) {
      console.log(`  ⚠ Update failed for ${t.source_trader_id}/${t.season_id}: ${error.message}`)
    } else {
      updated++
    }
  }

  console.log(`\n✅ Done: ${updated}/${traders.length} rows updated`)
}

main().catch(e => { console.error(e); process.exit(1) })
