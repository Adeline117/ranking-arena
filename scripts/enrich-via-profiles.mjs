/**
 * Enrichment via individual trader profile pages
 * 
 * For platforms where leaderboard API doesn't return WR/DD,
 * fetch individual profile/detail pages.
 * 
 * Toobit: Use leaders-new list (has leaderProfitOrderRatio = WR)
 *         Compute MDD from leaderTradeProfit curve
 * LBank: Fetch individual trader pages for win_rate/drawDown
 * Phemex: Individual trader pages via browser (CloudFront)
 * BloFin: Individual trader pages via browser (Cloudflare)
 * CoinEx: Individual trader pages via browser
 */
import { chromium } from 'playwright'
import { getSupabaseClient, calculateArenaScore, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()

async function enrichLbank() {
  console.log('\n=== LBank Enrichment via Individual Trader Pages ===')

  const { data: gaps } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'lbank')
    .or('win_rate.is.null,max_drawdown.is.null')

  if (!gaps?.length) { console.log('No LBank gaps'); return }
  
  const traderIds = [...new Set(gaps.map(g => g.source_trader_id))]
  console.log(`${gaps.length} gaps across ${traderIds.length} traders`)

  const traderData = new Map()
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html',
  }

  // Try fetching main listing page with all categories
  const resp = await fetch('https://www.lbank.com/copy-trading', { headers: HEADERS })
  if (!resp.ok) { console.log(`  HTTP ${resp.status}`); return }
  const html = await resp.text()
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
  if (!match) { console.log('  No __NEXT_DATA__'); return }

  const nextData = JSON.parse(match[1])
  const topTraders = nextData?.props?.pageProps?.topTraders || {}

  for (const [key, value] of Object.entries(topTraders)) {
    let items = Array.isArray(value) ? value : (value?.traderInfoResps || [])
    for (const item of items) {
      const uuid = item.uuid || item.name || ''
      if (!uuid) continue
      const wr = parseFloat(item.omWinRate || item.swinRate || item.winRate || 0)
      const dd = parseFloat(item.drawDown || 0)
      if (wr > 0 || dd > 0) {
        const normalizedWr = wr > 0 && wr <= 1 ? wr * 100 : wr
        traderData.set(uuid, { winRate: normalizedWr || null, maxDrawdown: dd || null })
      }
    }
  }
  console.log(`  Got ${traderData.size} traders from SSR`)

  // Update DB
  let updated = 0
  for (const gap of gaps) {
    const trader = traderData.get(gap.source_trader_id)
    if (!trader) continue

    const updates = {}
    if (gap.win_rate == null && trader.winRate != null && trader.winRate > 0) updates.win_rate = trader.winRate
    if (gap.max_drawdown == null && trader.maxDrawdown != null && trader.maxDrawdown > 0) updates.max_drawdown = trader.maxDrawdown
    if (!Object.keys(updates).length) continue

    const newWr = updates.win_rate ?? gap.win_rate
    const newMdd = updates.max_drawdown ?? gap.max_drawdown
    updates.arena_score = calculateArenaScore(gap.roi, gap.pnl, newMdd, newWr, gap.season_id).totalScore

    const { error } = await supabase
      .from('trader_snapshots')
      .update(updates)
      .eq('source', 'lbank')
      .eq('source_trader_id', gap.source_trader_id)
      .eq('season_id', gap.season_id)
    if (!error) updated++
  }
  console.log(`✅ LBank: ${updated} updated`)
}

async function enrichPhemexBrowser() {
  console.log('\n=== Phemex Enrichment (Browser Intercept) ===')

  const { data: gaps } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'phemex')
    .or('win_rate.is.null,max_drawdown.is.null')

  if (!gaps?.length) { console.log('No Phemex gaps'); return }
  const traderIds = new Set(gaps.map(g => g.source_trader_id))
  console.log(`${gaps.length} gaps, ${traderIds.size} unique traders`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })

  const traderData = new Map()
  
  try {
    // Load the page and intercept API responses
    const page = await ctx.newPage()
    
    page.on('response', async (r) => {
      const url = r.url()
      if (!url.includes('user/recommend') && !url.includes('user/leaders')) return
      try {
        const json = await r.json()
        const rows = json?.data?.rows || json?.data?.list || []
        if (!Array.isArray(rows)) return
        for (const t of rows) {
          const id = String(t.userId || t.uid || '')
          if (!id || !traderIds.has(id)) continue
          traderData.set(id, {
            winRate: t.winRate != null ? parseFloat(String(t.winRate)) : null,
            maxDrawdown: t.maxDrawdown != null ? Math.abs(parseFloat(String(t.maxDrawdown))) : null,
          })
        }
      } catch {}
    })

    await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await sleep(12000)

    // Dismiss popups
    for (const text of ['OK', 'Got it', 'Accept', 'Close', 'I Agree', 'Confirm']) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.count() > 0) await btn.first().click().catch(() => {})
    }
    await sleep(3000)

    console.log(`  Intercepted ${traderData.size} traders from initial load`)

    // Scroll to trigger more API calls
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      const nextBtn = page.locator('[class*="next"], button:has-text("More")').first()
      if (await nextBtn.count() > 0) await nextBtn.click().catch(() => {})
      await sleep(1500)
    }

    console.log(`  After scrolling: ${traderData.size} traders`)

    // Update DB
    let updated = 0
    for (const gap of gaps) {
      const trader = traderData.get(gap.source_trader_id)
      if (!trader) continue

      const updates = {}
      if (gap.win_rate == null && trader.winRate != null) updates.win_rate = trader.winRate
      if (gap.max_drawdown == null && trader.maxDrawdown != null) updates.max_drawdown = trader.maxDrawdown
      if (!Object.keys(updates).length) continue

      const newWr = updates.win_rate ?? gap.win_rate
      const newMdd = updates.max_drawdown ?? gap.max_drawdown
      updates.arena_score = calculateArenaScore(gap.roi, gap.pnl, newMdd, newWr, gap.season_id).totalScore

      const { error } = await supabase
        .from('trader_snapshots')
        .update(updates)
        .eq('source', 'phemex')
        .eq('source_trader_id', gap.source_trader_id)
        .eq('season_id', gap.season_id)
      if (!error) updated++
    }
    console.log(`✅ Phemex: ${updated} updated`)
  } catch (e) {
    console.error(`Phemex error: ${e.message}`)
  } finally {
    await browser.close()
  }
}

async function enrichBlofin() {
  console.log('\n=== BloFin Enrichment (Browser) ===')

  const { data: gaps } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'blofin')
    .or('win_rate.is.null,max_drawdown.is.null')

  if (!gaps?.length) { console.log('No BloFin gaps'); return }
  const traderIds = new Set(gaps.map(g => g.source_trader_id))
  console.log(`${gaps.length} gaps, ${traderIds.size} unique traders`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  const traderData = new Map()

  try {
    // Intercept API responses
    page.on('response', async (r) => {
      const url = r.url()
      if (!url.includes('trader/rank') && !url.includes('trader/list') && !url.includes('trader/detail')) return
      try {
        const json = await r.json()
        if (!json.data) return
        const processItems = (items) => {
          for (const t of items) {
            const id = String(t.uid || t.uniqueName || '')
            if (!id) continue
            let wr = t.winRate != null ? parseFloat(String(t.winRate)) : null
            if (wr != null && wr > 0 && wr <= 1) wr *= 100
            let mdd = t.mdd != null ? Math.abs(parseFloat(String(t.mdd))) : null
            traderData.set(id, { winRate: wr, maxDrawdown: mdd })
          }
        }
        if (Array.isArray(json.data)) processItems(json.data)
        else {
          for (const [k, v] of Object.entries(json.data)) {
            if (Array.isArray(v)) processItems(v)
          }
        }
      } catch {}
    })

    await page.goto('https://blofin.com/copy-trade?tab=leaderboard&module=futures', {
      timeout: 60000, waitUntil: 'domcontentloaded'
    })
    await sleep(15000)

    const title = await page.title()
    console.log(`  Title: ${title}`)
    console.log(`  Intercepted: ${traderData.size} traders`)

    // Scroll for more
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
    console.log(`  After scrolling: ${traderData.size} traders`)

    // Try individual detail pages for missing traders
    const missing = [...traderIds].filter(id => !traderData.has(id))
    if (missing.length > 0 && traderData.size > 0) {
      console.log(`  Fetching ${Math.min(missing.length, 30)} individual profiles...`)
      for (const uid of missing.slice(0, 30)) {
        try {
          await page.goto(`https://blofin.com/copy-trade/trader/${uid}`, { timeout: 20000, waitUntil: 'domcontentloaded' })
          await sleep(3000)
        } catch {}
      }
      console.log(`  After profiles: ${traderData.size}`)
    }

    // Update DB
    let updated = 0
    for (const gap of gaps) {
      const trader = traderData.get(gap.source_trader_id)
      if (!trader) continue

      const updates = {}
      if (gap.win_rate == null && trader.winRate != null) updates.win_rate = trader.winRate
      if (gap.max_drawdown == null && trader.maxDrawdown != null) updates.max_drawdown = trader.maxDrawdown
      if (!Object.keys(updates).length) continue

      const newWr = updates.win_rate ?? gap.win_rate
      const newMdd = updates.max_drawdown ?? gap.max_drawdown
      updates.arena_score = calculateArenaScore(gap.roi, gap.pnl, newMdd, newWr, gap.season_id).totalScore

      const { error } = await supabase
        .from('trader_snapshots')
        .update(updates)
        .eq('source', 'blofin')
        .eq('source_trader_id', gap.source_trader_id)
        .eq('season_id', gap.season_id)
      if (!error) updated++
    }
    console.log(`✅ BloFin: ${updated} updated`)
  } catch (e) {
    console.error(`BloFin error: ${e.message}`)
  } finally {
    await browser.close()
  }
}

async function enrichCoinex() {
  console.log('\n=== CoinEx Enrichment (Browser) ===')

  const { data: gaps } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'coinex')
    .or('win_rate.is.null,max_drawdown.is.null')

  if (!gaps?.length) { console.log('No CoinEx gaps'); return }
  const traderIds = [...new Set(gaps.map(g => g.source_trader_id))]
  console.log(`${gaps.length} gaps, ${traderIds.length} unique traders`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  const traderData = new Map()

  try {
    // Intercept copy trading API responses
    page.on('response', async (r) => {
      const url = r.url()
      if (!url.includes('copy') && !url.includes('trader')) return
      try {
        const json = await r.json()
        const items = json?.data?.list || json?.data?.traders || (Array.isArray(json?.data) ? json.data : [])
        for (const item of items) {
          const name = item.nickname || item.nick_name || ''
          if (!name) continue
          const wr = item.win_rate != null ? parseFloat(item.win_rate) : null
          const mdd = item.max_drawdown != null ? Math.abs(parseFloat(item.max_drawdown)) : null
          if (wr != null || mdd != null) traderData.set(name, { winRate: wr, maxDrawdown: mdd })
        }
      } catch {}
    })

    await page.goto('https://www.coinex.com/en/copy-trading/futures', {
      waitUntil: 'domcontentloaded', timeout: 60000
    })
    await sleep(15000)

    console.log(`  Intercepted: ${traderData.size} traders`)

    // Scroll through pages
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      // Click next page
      const clicked = await page.evaluate(() => {
        const items = document.querySelectorAll('.via-pager li.number, [class*="next"]')
        for (const item of items) {
          if (!item.classList.contains('active')) { item.click(); return true }
        }
        return false
      })
      if (!clicked) break
      await sleep(3000)
    }
    console.log(`  After pagination: ${traderData.size} traders`)

    // Update DB
    let updated = 0
    for (const gap of gaps) {
      const trader = traderData.get(gap.source_trader_id)
      if (!trader) continue

      const updates = {}
      if (gap.win_rate == null && trader.winRate != null) updates.win_rate = trader.winRate
      if (gap.max_drawdown == null && trader.maxDrawdown != null) updates.max_drawdown = trader.maxDrawdown
      if (!Object.keys(updates).length) continue

      const newWr = updates.win_rate ?? gap.win_rate
      const newMdd = updates.max_drawdown ?? gap.max_drawdown
      updates.arena_score = calculateArenaScore(gap.roi, gap.pnl, newMdd, newWr, gap.season_id).totalScore

      const { error } = await supabase
        .from('trader_snapshots')
        .update(updates)
        .eq('source', 'coinex')
        .eq('source_trader_id', gap.source_trader_id)
        .eq('season_id', gap.season_id)
      if (!error) updated++
    }
    console.log(`✅ CoinEx: ${updated} updated`)
  } catch (e) {
    console.error(`CoinEx error: ${e.message}`)
  } finally {
    await browser.close()
  }
}

async function main() {
  console.log('=== Profile-Based Enrichment ===')
  console.log('Time:', new Date().toISOString())

  await enrichLbank()
  await enrichPhemexBrowser()
  await enrichBlofin()
  await enrichCoinex()

  console.log('\n=== All done ===')
}

main().catch(e => { console.error(e); process.exit(1) })
