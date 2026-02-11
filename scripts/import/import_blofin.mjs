/**
 * BloFin Copy Trading scraper (Playwright)
 *
 * URL: blofin.com/copy-trade?tab=leaderboard&module=futures
 * API: /uapi/v1/copy/trader/rank (categorized lists ~15 each)
 *      Also try: /uapi/v1/copy/trader/list or pagination
 *      Cloudflare protected; need browser session
 *
 * Strategy: Load leaderboard page, intercept API, use in-page fetch,
 *   and scrape DOM for additional traders via infinite scroll
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

function parseTrader(t) {
  let roi = parseFloat(String(t.roi || 0))
  let mdd = t.mdd != null ? Math.abs(parseFloat(String(t.mdd))) : null
  let wr = t.winRate != null ? parseFloat(String(t.winRate)) : null
  if (wr != null && wr > 0 && wr <= 1) wr *= 100
  return {
    id: String(t.uid || t.uniqueName || ''),
    name: t.nick_name || t.nickName || `Trader_${String(t.uid || '').slice(0, 8)}`,
    avatar: t.profile || t.avatar || null,
    roi, pnl: parseFloat(String(t.pnl || 0)),
    mdd, winRate: wr,
    followers: parseInt(String(t.followers || t.copiers || 0)),
    aum: parseFloat(String(t.aum || 0)),
  }
}

async function scrapeTraders() {
  console.log('BloFin: launching browser...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await ctx.newPage()

  const tradersByPeriod = { '7D': new Map(), '30D': new Map(), '90D': new Map() }
  const allApiUrls = new Set()

  // Intercept all API responses
  page.on('response', async (r) => {
    const url = r.url()
    if (url.includes('/copy/') || url.includes('/trader')) {
      allApiUrls.add(url.split('?')[0])
    }
    if (!url.includes('trader/rank') && !url.includes('trader/list')) return
    try {
      const json = await r.json()
      if (!json.data) return
      // Handle rank endpoint (categorized)
      if (typeof json.data === 'object' && !Array.isArray(json.data)) {
        for (const [key, list] of Object.entries(json.data)) {
          if (!Array.isArray(list) || !list.length) continue
          const rangeTime = list[0].range_time
          const period = rangeTime === 1 ? '7D' : rangeTime === 3 ? '90D' : '30D'
          const map = tradersByPeriod[period]
          for (const t of list) {
            const trader = parseTrader(t)
            if (trader.id && !map.has(trader.id)) map.set(trader.id, trader)
          }
        }
      }
      // Handle list endpoint (array)
      if (Array.isArray(json.data)) {
        for (const t of json.data) {
          const trader = parseTrader(t)
          if (!trader.id) continue
          for (const map of Object.values(tradersByPeriod)) {
            if (!map.has(trader.id)) map.set(trader.id, trader)
          }
        }
      }
    } catch {}
  })

  try {
    await page.goto('https://blofin.com/copy-trade?tab=leaderboard&module=futures', { timeout: 45000, waitUntil: 'domcontentloaded' })
    await sleep(8000)
    const title = await page.title()
    console.log(`  Title: ${title}`)
    if (title.includes('moment') || title.includes('Check')) {
      console.log('  Cloudflare challenge, waiting...')
      await sleep(15000)
    }

    // Check what API URLs were discovered
    console.log(`  Discovered APIs: ${[...allApiUrls].join(', ')}`)
    for (const [p, m] of Object.entries(tradersByPeriod)) {
      if (m.size > 0) console.log(`  ${p}: ${m.size} from initial load`)
    }

    // Fetch rank API for all periods
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
            const trader = parseTrader(t)
            if (trader.id && !map.has(trader.id)) map.set(trader.id, trader)
          }
        }
        console.log(`  ${period} rank: ${map.size} unique`)
      } else {
        console.log(`  ${period} rank: failed - ${result?.error || result?.msg || 'unknown'}`)
      }
      await sleep(500)
    }

    // Try additional endpoints for more traders
    const endpoints = [
      '/uapi/v1/copy/trader/list',
      '/uapi/v1/copy/trader/search',
      '/uapi/v1/copy/trader/all',
      '/uapi/v1/copy/trader/leaderboard',
    ]

    for (const ep of endpoints) {
      for (const rangeTime of [1, 2, 3]) {
        const period = rangeTime === 1 ? '7D' : rangeTime === 3 ? '90D' : '30D'
        // Try GET
        const result = await page.evaluate(async ({ ep, rangeTime }) => {
          try {
            let r = await fetch(`${ep}?range_time=${rangeTime}&page=1&pageSize=100&limit=100`)
            if (!r.ok) r = await fetch(`${ep}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ range_time: rangeTime, page: 1, pageSize: 100 }),
            })
            return await r.json()
          } catch { return null }
        }, { ep, rangeTime })

        if (result?.data) {
          const map = tradersByPeriod[period]
          const list = Array.isArray(result.data) ? result.data :
                       Array.isArray(result.data.list) ? result.data.list :
                       Array.isArray(result.data.rows) ? result.data.rows : []
          let added = 0
          for (const t of list) {
            const trader = parseTrader(t)
            if (trader.id && !map.has(trader.id)) { map.set(trader.id, trader); added++ }
          }
          if (added) console.log(`  ${ep} ${period}: +${added}`)
        }
      }
    }

    // Try scrolling the leaderboard page for more data
    console.log('  Scrolling for more traders...')
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
    }

    // Try to scrape DOM if APIs didn't give enough
    const totalApi = Math.max(...Object.values(tradersByPeriod).map(m => m.size))
    if (totalApi < 50) {
      console.log('  Scraping DOM for additional traders...')
      const domTraders = await page.evaluate(() => {
        const cards = document.querySelectorAll('[class*="trader"], [class*="leader"], [class*="card"]')
        const results = []
        cards.forEach(card => {
          const name = card.querySelector('[class*="name"], [class*="nick"]')?.textContent?.trim()
          const roi = card.querySelector('[class*="roi"], [class*="rate"], [class*="percent"]')?.textContent?.trim()
          const pnl = card.querySelector('[class*="pnl"], [class*="profit"]')?.textContent?.trim()
          if (name && roi) results.push({ name, roi, pnl })
        })
        return results
      })
      if (domTraders.length) console.log(`  DOM scraped: ${domTraders.length} potential traders`)
    }

  } catch (e) {
    console.error(`  Error: ${e.message}`)
  } finally {
    await browser.close()
  }

  return tradersByPeriod
}

async function saveTraders(traders, period) {
  if (!traders.length) { console.log(`  ⚠ ${period}: no data`); return 0 }
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const now = new Date().toISOString()
  console.log(`\n💾 Saving ${traders.length} ${period} records...`)

  for (let i = 0; i < traders.length; i += 30) {
    await supabase.from('trader_sources').upsert(
      traders.slice(i, i + 30).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
      })),
      { onConflict: 'source,source_trader_id' }
    )
  }

  let saved = 0
  for (let i = 0; i < traders.length; i += 30) {
    const batch = traders.slice(i, i + 30).map((t, j) => {
      const scores = calculateArenaScore(t.roi, t.pnl, t.mdd, t.winRate, period)
      return {
        source: SOURCE, source_trader_id: t.id, season_id: period,
        rank: i + j + 1, roi: t.roi, pnl: t.pnl,
        max_drawdown: t.mdd, win_rate: t.winRate,
        followers: t.followers, arena_score: scores.totalScore,
        captured_at: now,
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
    // Fallback: use another period's data
    if (!traders.length) {
      for (const fb of ['30D', '7D', '90D']) {
        if (tradersByPeriod[fb]?.size > 0) {
          traders = [...tradersByPeriod[fb].values()]
          console.log(`  ${p}: using ${fb} fallback (${traders.length})`)
          break
        }
      }
    }
    total += await saveTraders(traders, p)
  }

  console.log(`\n✅ BloFin done: ${total} records saved`)
}

main().catch(e => { console.error(e); process.exit(1) })
