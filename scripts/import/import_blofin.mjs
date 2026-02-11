/**
 * BloFin Copy Trading scraper (Playwright)
 *
 * URL: blofin.com/en/copy-trade
 * API: blofin.com/uapi/v1/copy/trader/rank
 *   - Returns categorized lists: top_roi_list, top_predunt_list,
 *     highest_copier_pnl_list, top_new_talent_list (~15 each)
 *   - range_time: 1=7D, 2=30D, 3=90D
 *   - Fields: uid, nick_name, roi, pnl, mdd, sharpe_ratio, followers, aum
 *   - Cloudflare protected; need browser session for API calls
 *
 * Usage: node scripts/import/import_blofin.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'blofin'
const PROXY = 'http://127.0.0.1:7890'

const PERIOD_MAP = { '7D': 1, '30D': 2, '90D': 3 }

async function scrapeTraders() {
  console.log('BloFin: launching browser...')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await ctx.newPage()

  // Collect all traders from API interception
  const tradersByPeriod = { '7D': new Map(), '30D': new Map(), '90D': new Map() }

  page.on('response', async (r) => {
    if (!r.url().includes('trader/rank')) return
    try {
      const json = await r.json()
      if (json.code !== 200 || !json.data) return
      // Determine period from range_time of first item
      for (const [key, list] of Object.entries(json.data)) {
        if (!Array.isArray(list) || !list.length) continue
        const rangeTime = list[0].range_time
        const period = rangeTime === 1 ? '7D' : rangeTime === 3 ? '90D' : '30D'
        const map = tradersByPeriod[period]
        for (const t of list) {
          const uid = String(t.uid)
          if (!uid || map.has(uid)) continue
          map.set(uid, parseTrader(t))
        }
      }
    } catch {}
  })

  try {
    await page.goto('https://blofin.com/en/copy-trade', { timeout: 45000, waitUntil: 'domcontentloaded' })
    await sleep(8000)

    const title = await page.title()
    console.log(`  Title: ${title}`)
    if (title.includes('moment')) {
      console.log('  Cloudflare challenge, waiting...')
      await sleep(15000)
    }

    // Initial load captures default period (30D)
    for (const [p, m] of Object.entries(tradersByPeriod)) {
      if (m.size > 0) console.log(`  ${p}: ${m.size} traders from initial load`)
    }

    // Now use in-page fetch to get all periods
    for (const [period, rangeTime] of Object.entries(PERIOD_MAP)) {
      const result = await page.evaluate(async (rt) => {
        try {
          const r = await fetch(`/uapi/v1/copy/trader/rank?range_time=${rt}`)
          return await r.json()
        } catch (e) { return { error: e.message } }
      }, rangeTime)

      if (result?.code === 200 && result.data) {
        const map = tradersByPeriod[period]
        for (const [key, list] of Object.entries(result.data)) {
          if (!Array.isArray(list)) continue
          for (const t of list) {
            const uid = String(t.uid)
            if (!uid || map.has(uid)) continue
            map.set(uid, parseTrader(t))
          }
        }
        console.log(`  ${period} (range_time=${rangeTime}): ${map.size} unique traders`)
      } else {
        console.log(`  ${period}: fetch failed - ${result?.error || result?.msg || 'unknown'}`)
      }
      await sleep(1000)
    }
  } catch (e) {
    console.error(`  Error: ${e.message}`)
  } finally {
    await browser.close()
  }

  return tradersByPeriod
}

function parseTrader(t) {
  let roi = parseFloat(String(t.roi || 0))
  // roi is already percentage (e.g. 23.01 = 23.01%)
  let mdd = t.mdd != null ? Math.abs(parseFloat(String(t.mdd))) : null
  // mdd is also percentage
  return {
    id: String(t.uid),
    name: t.nick_name || `Trader_${String(t.uid).slice(0, 8)}`,
    avatar: t.profile || null,
    roi,
    pnl: parseFloat(String(t.pnl || 0)),
    mdd,
    followers: parseInt(String(t.followers || 0)),
    aum: parseFloat(String(t.aum || 0)),
  }
}

async function saveTraders(traders, period) {
  if (!traders.length) { console.log(`  ⚠ ${period}: no data`); return 0 }
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

  const now = new Date().toISOString()
  console.log(`\n💾 Saving ${traders.length} ${period} records...`)

  // Upsert sources
  for (let i = 0; i < traders.length; i += 30) {
    await supabase.from('trader_sources').upsert(
      traders.slice(i, i + 30).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
      })),
      { onConflict: 'source,source_trader_id' }
    )
  }

  // Upsert snapshots
  let saved = 0
  for (let i = 0; i < traders.length; i += 30) {
    const batch = traders.slice(i, i + 30).map((t, j) => {
      const scores = calculateArenaScore(t.roi, t.pnl, t.mdd, null, period)
      return {
        source: SOURCE, source_trader_id: t.id, season_id: period,
        rank: i + j + 1, roi: t.roi, pnl: t.pnl,
        max_drawdown: t.mdd, followers: t.followers,
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
  console.log(`BloFin scraper | Periods: ${periods.join(', ')}`)

  const tradersByPeriod = await scrapeTraders()

  let total = 0
  for (const p of periods) {
    const map = tradersByPeriod[p]
    let traders = map ? [...map.values()] : []
    // If empty, try to use another period's data
    if (!traders.length) {
      for (const fallback of ['30D', '7D', '90D']) {
        if (tradersByPeriod[fallback]?.size > 0) {
          traders = [...tradersByPeriod[fallback].values()]
          console.log(`  ${p}: using ${fallback} data as fallback (${traders.length} traders)`)
          break
        }
      }
    }
    total += await saveTraders(traders, p)
  }

  console.log(`\n✅ BloFin done: ${total} records saved`)
}

main().catch(e => { console.error(e); process.exit(1) })
