/**
 * Enrich Phemex traders with WR/MDD data
 * Strategy: Use Playwright to establish browser session, then make API calls
 * via page.evaluate with cookies/session from the loaded page.
 */
import { chromium } from 'playwright'
import { getSupabaseClient, calculateArenaScore, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const PROXY = process.env.PROXY_URL || ''

async function fetchAllTraders() {
  console.log('Launching browser...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctxOpts = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
  if (PROXY) ctxOpts.proxy = { server: PROXY }
  const context = await browser.newContext(ctxOpts)
  const page = await context.newPage()

  // Intercept recommend API to capture cookies/headers that work
  const allTraders = new Map()

  page.on('response', async (resp) => {
    if (!resp.url().includes('user/recommend')) return
    try {
      const json = await resp.json().catch(() => null)
      const rows = json?.data?.rows || []
      for (const t of rows) {
        const id = String(t.userId || '')
        if (id && !allTraders.has(id)) allTraders.set(id, parseTrader(t))
      }
    } catch {}
  })

  await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await sleep(10000)

  // Dismiss popups
  for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'I Agree']) {
    const btn = page.getByRole('button', { name: text })
    if (await btn.count() > 0) await btn.first().click().catch(() => {})
  }
  await sleep(2000)
  console.log(`  After initial load: ${allTraders.size} traders`)

  // Get cookies for direct API calls
  const cookies = await context.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  // Scroll to load all traders (API is CloudFront-protected, only works via page navigation)
  let staleCount = 0
  for (let i = 0; i < 100; i++) {
    const before = allTraders.size
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(1500)
    // Try clicking pagination/load more
    for (const sel of ['[class*="next"]', 'button:has-text("More")', '[class*="pagination"] li:last-child']) {
      const el = page.locator(sel).first()
      if (await el.count() > 0) await el.click().catch(() => {})
    }
    await sleep(1500)
    const after = allTraders.size
    if (after > before) {
      console.log(`  Scroll ${i + 1}: ${after} traders (+${after - before})`)
      staleCount = 0
    } else {
      staleCount++
      if (staleCount > 5) {
        console.log(`  No new traders after 5 scrolls, stopping at ${after}`)
        break
      }
    }
  }

  await browser.close()
  return [...allTraders.values()]
}

function parseTrader(t) {
  return {
    userId: String(t.userId || ''),
    tradeWinRate30d: t.tradeWinRate30d != null ? parseFloat(t.tradeWinRate30d) : null,
    tradeWinRate90d: t.tradeWinRate90d != null ? parseFloat(t.tradeWinRate90d) : null,
    tradeWinRate180d: t.tradeWinRate180d != null ? parseFloat(t.tradeWinRate180d) : null,
    mdd30d: t.mdd30d != null ? Math.abs(parseFloat(t.mdd30d)) : null,
    mdd90d: t.mdd90d != null ? Math.abs(parseFloat(t.mdd90d)) : null,
    mdd180d: t.mdd180d != null ? Math.abs(parseFloat(t.mdd180d)) : null,
    roi7d: parseFloat(t.pnlRate7d || 0) * 100,
    roi30d: parseFloat(t.pnlRate30d || 0) * 100,
    roi90d: parseFloat(t.pnlRate90d || 0) * 100,
    pnl7d: parseFloat(t.pnl7d || 0),
    pnl30d: parseFloat(t.pnl30d || 0),
    pnl90d: parseFloat(t.pnl90d || 0),
  }
}

async function enrichDB(traders) {
  console.log(`\nEnriching ${traders.length} traders in DB...`)

  const periodMap = {
    '7D':  { wr: 'tradeWinRate30d', mdd: 'mdd30d', roi: 'roi7d', pnl: 'pnl7d', fb_roi: 'roi30d', fb_pnl: 'pnl30d' },
    '30D': { wr: 'tradeWinRate30d', mdd: 'mdd30d', roi: 'roi30d', pnl: 'pnl30d' },
    '90D': { wr: 'tradeWinRate90d', mdd: 'mdd90d', roi: 'roi90d', pnl: 'pnl90d', fb_roi: 'roi30d', fb_pnl: 'pnl30d' },
  }

  for (const [period, fields] of Object.entries(periodMap)) {
    let updated = 0
    for (let i = 0; i < traders.length; i += 30) {
      const batch = traders.slice(i, i + 30)
      const updates = batch.map(t => {
        const winRate = t[fields.wr]
        const mdd = t[fields.mdd]
        const winRatePct = winRate != null ? winRate * 100 : null
        const mddPct = mdd != null ? mdd * 100 : null
        const roi = t[fields.roi] || (fields.fb_roi ? t[fields.fb_roi] : 0) || 0
        const pnl = t[fields.pnl] || (fields.fb_pnl ? t[fields.fb_pnl] : 0) || 0
        const scores = calculateArenaScore(roi, pnl, mddPct, winRatePct, period)
        return {
          source: 'phemex',
          source_trader_id: t.userId,
          season_id: period,
          win_rate: winRatePct,
          max_drawdown: mddPct,
          arena_score: scores.totalScore,
        }
      })
      const { error } = await supabase
        .from('trader_snapshots')
        .upsert(updates, { onConflict: 'source,source_trader_id,season_id' })
      if (error) console.log(`  ⚠ ${period} error: ${error.message}`)
      else updated += batch.length
    }
    console.log(`  ✅ ${period}: ${updated} records`)
  }
}

async function main() {
  const { data: before } = await supabase
    .from('trader_snapshots')
    .select('season_id, win_rate, max_drawdown')
    .eq('source', 'phemex')
    .not('win_rate', 'is', null)
  console.log(`BEFORE: ${before?.length || 0} records with non-null win_rate`)

  const traders = await fetchAllTraders()
  if (!traders.length) { console.log('❌ No data'); process.exit(1) }

  console.log(`\nSample: ${JSON.stringify(traders[0])}`)
  await enrichDB(traders)

  const { data: after } = await supabase
    .from('trader_snapshots')
    .select('season_id, win_rate, max_drawdown')
    .eq('source', 'phemex')
    .not('win_rate', 'is', null)
  console.log(`\nAFTER: ${after?.length || 0} records with non-null win_rate`)
  const bySeason = {}
  for (const r of (after || [])) bySeason[r.season_id] = (bySeason[r.season_id] || 0) + 1
  for (const [s, c] of Object.entries(bySeason)) console.log(`  ${s}: ${c}`)

  const { data: sample } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown, arena_score')
    .eq('source', 'phemex').eq('season_id', '90D')
    .not('win_rate', 'is', null).limit(5)
  console.log('\nSample DB:')
  for (const r of (sample || [])) console.log(`  ${r.source_trader_id}: WR=${r.win_rate}% MDD=${r.max_drawdown}% Score=${r.arena_score}`)
}

main().catch(e => { console.error(e); process.exit(1) })
