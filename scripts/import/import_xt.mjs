/**
 * XT Copy Trading scraper (Playwright)
 *
 * URL: xt.com/en/copy-trading/futures
 * API: xt.com/fapi/user/v1/public/copy-trade/leader-list-v2
 *   - Paginated: pageNo=N, pageSize ignored (always 10/page), hasNext for pagination
 *   - days=7|30|90
 *   - Fields: accountId, nickName, income, incomeRate(decimal), winRate(decimal),
 *     maxRetraction, followerCount, avatar
 *   - Needs browser cookies (Cloudflare)
 *
 * Usage: node scripts/import/import_xt.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'xt'
const PROXY = 'http://127.0.0.1:7890'

async function scrapeTraders() {
  console.log('XT: launching browser...')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await ctx.newPage()

  // Load page to establish CF cookies
  await page.goto('https://www.xt.com/en/copy-trading/futures', { timeout: 45000, waitUntil: 'domcontentloaded' })

  // Wait for CF
  for (let i = 0; i < 20; i++) {
    const t = await page.title().catch(() => '')
    if (t && !t.includes('moment') && !t.includes('Check') && t.length > 5) break
    await sleep(1500)
  }
  await sleep(5000)
  console.log(`  Title: ${await page.title()}`)

  const tradersByPeriod = { '7D': new Map(), '30D': new Map(), '90D': new Map() }
  const allTraders = new Map()

  for (const [periodKey, days] of [['7D', 7], ['30D', 30], ['90D', 90]]) {
    const map = tradersByPeriod[periodKey]
    let pageNo = 1
    let hasNext = true

    while (hasNext && pageNo <= 100) {
      const result = await page.evaluate(async ({ days, pageNo }) => {
        try {
          const r = await fetch(
            `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-list-v2?pageNo=${pageNo}&pageSize=50&days=${days}`,
            { credentials: 'include' }
          )
          return await r.json()
        } catch (e) { return { error: e.message } }
      }, { days, pageNo })

      if (result?.error || result?.returnCode !== 0) {
        console.log(`  ${periodKey} page ${pageNo}: error - ${result?.error || JSON.stringify(result).slice(0, 100)}`)
        break
      }

      const items = result.result?.items || []
      if (!items.length) break

      let added = 0
      for (const it of items) {
        const t = parseTrader(it)
        if (t && !map.has(t.id)) { map.set(t.id, t); allTraders.set(t.id, t); added++ }
      }

      hasNext = result.result?.hasNext === true
      process.stdout.write(`\r  ${periodKey}: page ${pageNo}, +${added}, total ${map.size}`)
      pageNo++
      await sleep(300 + Math.random() * 300)
    }
    console.log()
  }

  await browser.close()
  return { tradersByPeriod, allTraders }
}

function parseTrader(it) {
  const id = String(it.accountId || '')
  if (!id) return null

  let roi = it.incomeRate != null ? parseFloat(it.incomeRate) * 100 : null
  let pnl = it.income != null ? parseFloat(it.income) : null
  let wr = it.winRate != null ? parseFloat(it.winRate) : null
  if (wr != null && wr <= 1) wr *= 100
  let dd = it.maxRetraction != null ? Math.abs(parseFloat(it.maxRetraction)) : null
  if (dd != null && dd <= 1 && dd > 0) dd *= 100

  return {
    id, name: it.nickName || '', avatar: it.avatar || null,
    roi, pnl, wr, dd,
    followers: parseInt(it.followerCount || 0) || null,
  }
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log(`XT scraper | Periods: ${periods.join(', ')}`)

  const { tradersByPeriod, allTraders } = await scrapeTraders()
  console.log(`\nTotal unique traders: ${allTraders.size}`)

  const now = new Date().toISOString()
  let totalSaved = 0

  // Save sources
  const all = [...allTraders.values()]
  for (let i = 0; i < all.length; i += 50) {
    await supabase.from('trader_sources').upsert(
      all.slice(i, i + 50).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name || t.id,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
        profile_url: `https://www.xt.com/en/copy-trading/futures/detail/${t.id}`,
      })),
      { onConflict: 'source,source_trader_id' }
    ).catch(() => {})
  }

  // Save snapshots per period
  for (const p of periods) {
    const traders = [...(tradersByPeriod[p]?.values() || [])]
    if (!traders.length) { console.log(`  ${p}: no data`); continue }
    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

    let saved = 0
    for (let i = 0; i < traders.length; i += 30) {
      const batch = traders.slice(i, i + 30).map((t, j) => ({
        source: SOURCE, source_trader_id: t.id, season_id: p,
        rank: i + j + 1, roi: t.roi, pnl: t.pnl,
        win_rate: t.wr, max_drawdown: t.dd,
        arena_score: calculateArenaScore(t.roi, t.pnl, t.dd, t.wr, p).totalScore,
        captured_at: now,
      }))
      const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved += batch.length
    }
    console.log(`  ${p}: ${saved}/${traders.length} saved`)
    totalSaved += saved
  }

  console.log(`\n✅ XT done: ${totalSaved} records saved`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
