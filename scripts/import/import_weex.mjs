/**
 * WEEX Copy Trading scraper (Playwright)
 *
 * URL: weex.com/copy-trading
 * API: http-gateway1.janapw.com/api/v1/public/trace/traderListView (POST)
 *   - Body: {languageType, sortRule, simulation, pageNo, pageSize, nickName}
 *   - totals ~350, nextFlag for pagination, pageSize=20
 *   - sortRule: 9=default, others for different sorts
 *   - Fields: traderUserId, traderNickName, headPic, followCount,
 *     totalReturnRate, ndaysReturnRates, threeWeeksPNL
 *
 * Strategy: load page to establish session, then use in-page fetch for pagination
 *
 * Usage: node scripts/import/import_weex.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'weex'
const PROXY = 'http://127.0.0.1:7890'
const API_URL = 'https://http-gateway1.janapw.com/api/v1/public/trace/traderListView'

function parseTrader(item) {
  const id = String(item.traderUserId || '')
  if (!id) return null

  let roi = 0
  if (item.totalReturnRate != null) {
    roi = parseFloat(String(item.totalReturnRate))
    if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100
  }

  // Extract period-specific ROI from ndaysReturnRates
  const ratesByDays = {}
  if (Array.isArray(item.ndaysReturnRates)) {
    for (const r of item.ndaysReturnRates) {
      let rate = parseFloat(String(r.rate || 0))
      if (Math.abs(rate) > 0 && Math.abs(rate) < 1) rate *= 100
      ratesByDays[r.ndays] = rate
    }
  }

  return {
    id,
    name: item.traderNickName || item.nickName || `Trader_${id.slice(0, 8)}`,
    avatar: item.headPic || null,
    roi,
    roi7d: ratesByDays[7] || null,
    roi21d: ratesByDays[21] || roi,
    pnl: parseFloat(String(item.threeWeeksPNL || item.profit || 0)),
    followers: parseInt(String(item.followCount || 0)),
    winRate: item.winRate != null ? parseFloat(String(item.winRate)) : null,
    maxDrawdown: item.maxDrawdown != null ? parseFloat(String(item.maxDrawdown)) : null,
  }
}

async function scrapeTraders() {
  console.log('WEEX: launching browser...')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await ctx.newPage()

  // Also intercept responses in case direct fetch doesn't work
  const traders = new Map()
  page.on('response', async (r) => {
    if (!r.url().includes('traderListView')) return
    try {
      const json = await r.json()
      if (json.code !== 'SUCCESS' || !json.data?.rows) return
      for (const item of json.data.rows) {
        const t = parseTrader(item)
        if (t && !traders.has(t.id)) traders.set(t.id, t)
      }
    } catch {}
  })

  await page.goto('https://www.weex.com/copy-trading', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await sleep(10000)
  console.log(`  Title: ${await page.title()}, intercepted: ${traders.size}`)

  // Try direct fetch from page context with multiple sort rules
  for (const sortRule of [9, 5, 6, 7, 8, 2, 1]) {
    let pageNo = 1
    let hasMore = true

    while (hasMore && pageNo <= 30) {
      const result = await page.evaluate(async ({ url, sortRule, pageNo }) => {
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ languageType: 0, sortRule, simulation: 0, pageNo, pageSize: 20, nickName: '' }),
          })
          const d = await r.json()
          return d
        } catch (e) { return { error: e.message } }
      }, { url: API_URL, sortRule, pageNo })

      if (result?.error || result?.code !== 'SUCCESS') {
        if (pageNo === 1) console.log(`  sort=${sortRule}: failed - ${result?.error || result?.code}`)
        break
      }

      const rows = result.data?.rows || []
      if (!rows.length) break

      let added = 0
      for (const item of rows) {
        const t = parseTrader(item)
        if (t && !traders.has(t.id)) { traders.set(t.id, t); added++ }
      }

      hasMore = result.data?.nextFlag === true
      process.stdout.write(`\r  sort=${sortRule} p${pageNo}: +${added} → ${traders.size} (total=${result.data?.totals || '?'})`)

      if (added === 0 && pageNo > 2) break
      pageNo++
      await sleep(300 + Math.random() * 200)
    }
    console.log()
  }

  console.log(`  Total: ${traders.size} unique traders`)
  await browser.close()
  return [...traders.values()]
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log(`WEEX scraper | Periods: ${periods.join(', ')}`)

  const traders = await scrapeTraders()
  if (!traders.length) { console.log('❌ No data'); process.exit(1) }

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const now = new Date().toISOString()

  // Save sources
  for (let i = 0; i < traders.length; i += 50) {
    await supabase.from('trader_sources').upsert(
      traders.slice(i, i + 50).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
      })),
      { onConflict: 'source,source_trader_id' }
    ).catch(() => {})
  }

  let totalSaved = 0
  for (const period of periods) {
    console.log(`\n💾 Saving ${traders.length} ${period} records...`)
    let saved = 0

    for (let i = 0; i < traders.length; i += 30) {
      const batch = traders.slice(i, i + 30).map((t, j) => {
        const roi = t.roi || 0
        const scores = calculateArenaScore(roi, t.pnl, t.maxDrawdown, t.winRate, period)
        return {
          source: SOURCE, source_trader_id: t.id, season_id: period,
          rank: i + j + 1, roi, pnl: t.pnl || null,
          win_rate: t.winRate, max_drawdown: t.maxDrawdown,
          followers: t.followers, arena_score: scores.totalScore,
          captured_at: now,
        }
      })
      const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved += batch.length
    }

    console.log(`  ✅ ${saved}/${traders.length} saved`)
    totalSaved += saved
  }

  console.log(`\n✅ WEEX done: ${totalSaved} records saved`)
}

main().catch(e => { console.error(e); process.exit(1) })
