/**
 * Phemex / CoinEx / BloFin enrichment via Playwright
 * 
 * These platforms use CloudFlare protection, so we need browser context
 * to access their APIs. Strategy:
 * 
 * Phemex: In-page fetch of recommend API which includes winRate/maxDrawdown
 * CoinEx: Scrape trader profile pages for win_rate/max_drawdown
 * BloFin: In-page fetch of rank API which includes mdd/winRate
 * 
 * Only UPDATEs null fields, never deletes data.
 */
import { chromium } from 'playwright'
import { getSupabaseClient, calculateArenaScore, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const PROXY = 'http://127.0.0.1:7890'

// ============================================
// PHEMEX
// ============================================
async function enrichPhemex() {
  console.log('\n=== Phemex Enrichment ===')
  
  const { data: gaps } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'phemex')
    .or('win_rate.is.null,max_drawdown.is.null')

  if (!gaps?.length) { console.log('No Phemex gaps'); return }
  console.log(`${gaps.length} snapshot gaps`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  try {
    await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'domcontentloaded', timeout: 45000 })
    await sleep(8000)

    // Dismiss popups
    for (const text of ['OK', 'Got it', 'Accept', 'Close']) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.count() > 0) await btn.first().click().catch(() => {})
    }
    await sleep(2000)

    // Fetch all traders from recommend API with pagination
    const allTraders = new Map()
    for (let pageNum = 1; pageNum <= 20; pageNum++) {
      const result = await page.evaluate(async (pn) => {
        try {
          const r = await fetch(`https://api10.phemex.com/phemex-lb/public/data/v3/user/recommend?hideFullyCopied=false&keyword=&pageNum=${pn}&pageSize=100`)
          return await r.json()
        } catch (e) { return { error: e.message } }
      }, pageNum)

      const rows = result?.data?.rows || []
      if (!rows.length) break

      for (const t of rows) {
        const id = String(t.userId || '')
        if (!id) continue
        allTraders.set(id, {
          winRate: t.winRate != null ? parseFloat(String(t.winRate)) : null,
          maxDrawdown: t.maxDrawdown != null ? Math.abs(parseFloat(String(t.maxDrawdown))) : null,
        })
      }
      console.log(`  Page ${pageNum}: total ${allTraders.size}`)
      await sleep(500)
    }

    console.log(`Fetched ${allTraders.size} traders with detail data`)

    // Update DB
    let updated = 0
    for (const gap of gaps) {
      const trader = allTraders.get(gap.source_trader_id)
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

// ============================================
// COINEX
// ============================================
async function enrichCoinex() {
  console.log('\n=== CoinEx Enrichment ===')

  const { data: gaps } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'coinex')
    .or('win_rate.is.null,max_drawdown.is.null')

  if (!gaps?.length) { console.log('No CoinEx gaps'); return }
  console.log(`${gaps.length} snapshot gaps`)

  // Get unique trader IDs (these are nicknames used as IDs)
  const traderIds = [...new Set(gaps.map(g => g.source_trader_id))]
  console.log(`${traderIds.length} unique traders`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  const traderData = new Map()

  try {
    // Go to CoinEx copy trading page first
    await page.goto('https://www.coinex.com/en/copy-trading/futures', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await sleep(10000)

    // Try intercepting API calls for trader list data
    // CoinEx uses Nuxt SSR - try fetching internal API via page context
    const apiResult = await page.evaluate(async () => {
      // Try various CoinEx internal API endpoints
      const endpoints = [
        '/api/copy-trading/v1/trader/list',
        '/res/copy/trader/list',
        '/api/v1/copy-trading/trader/ranking',
      ]
      for (const ep of endpoints) {
        try {
          const params = new URLSearchParams({ page: '1', limit: '200', sort_by: 'roi', period: 'all' })
          const r = await fetch(`${ep}?${params}`)
          if (r.ok) {
            const data = await r.json()
            return { endpoint: ep, data }
          }
        } catch {}
      }
      return null
    })

    if (apiResult?.data) {
      console.log(`  Found API: ${apiResult.endpoint}`)
      const items = apiResult.data?.data?.list || apiResult.data?.data || []
      for (const item of items) {
        const name = item.nickname || item.nick_name || ''
        if (!name) continue
        traderData.set(name, {
          winRate: item.win_rate != null ? parseFloat(item.win_rate) : null,
          maxDrawdown: item.max_drawdown != null ? Math.abs(parseFloat(item.max_drawdown)) : null,
        })
      }
    }

    // If API didn't work, try scraping individual profile pages  
    if (traderData.size === 0) {
      console.log('  API not found, trying profile page scraping...')
      
      // Try to get data from the page's Vue/Nuxt store
      const storeData = await page.evaluate(() => {
        // Try accessing Nuxt store
        const nuxtData = window.__NUXT__
        if (nuxtData?.state?.copyTrading) return nuxtData.state.copyTrading
        // Try Vue devtools
        const app = document.querySelector('#__nuxt')?.__vue_app__
        if (app) {
          const stores = app.config?.globalProperties?.$pinia?._s
          if (stores) {
            for (const [key, store] of stores) {
              if (key.includes('copy') || key.includes('trader')) return { key, data: store.$state }
            }
          }
        }
        return null
      })
      
      if (storeData) {
        console.log(`  Found Nuxt store data: ${JSON.stringify(storeData).slice(0, 200)}`)
      }
    }

    console.log(`  Got detail for ${traderData.size} CoinEx traders`)

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

// ============================================
// BLOFIN
// ============================================
async function enrichBlofin() {
  console.log('\n=== BloFin Enrichment ===')

  const { data: gaps } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'blofin')
    .or('win_rate.is.null,max_drawdown.is.null')

  if (!gaps?.length) { console.log('No BloFin gaps'); return }
  console.log(`${gaps.length} snapshot gaps`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  const traderData = new Map()

  try {
    await page.goto('https://blofin.com/copy-trade?tab=leaderboard&module=futures', {
      timeout: 45000, waitUntil: 'domcontentloaded'
    })
    await sleep(10000)

    // Fetch rank API from within page context (bypasses Cloudflare)
    const result = await page.evaluate(async () => {
      try {
        const r = await fetch('/uapi/v1/copy/trader/rank', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nick_name: '', limit: 200 }),
        })
        return await r.json()
      } catch (e) { return { error: e.message } }
    })

    if (result?.code === 200 && result.data) {
      for (const [key, list] of Object.entries(result.data)) {
        if (!Array.isArray(list)) continue
        for (const t of list) {
          const id = String(t.uid || t.uniqueName || '')
          if (!id) continue
          let wr = t.winRate != null ? parseFloat(String(t.winRate)) : null
          if (wr != null && wr > 0 && wr <= 1) wr *= 100
          let mdd = t.mdd != null ? Math.abs(parseFloat(String(t.mdd))) : null
          traderData.set(id, { winRate: wr, maxDrawdown: mdd })
        }
      }
      console.log(`  Got ${traderData.size} from rank API`)
    }

    // Try fetching individual trader details for any still missing
    const missingIds = [...new Set(gaps.map(g => g.source_trader_id))].filter(id => !traderData.has(id))
    if (missingIds.length > 0) {
      console.log(`  Fetching ${missingIds.length} individual profiles...`)
      for (const uid of missingIds.slice(0, 50)) {
        const detail = await page.evaluate(async (uid) => {
          try {
            const r = await fetch(`/uapi/v1/copy/trader/detail?uniqueName=${uid}`)
            if (!r.ok) {
              const r2 = await fetch(`/uapi/v1/copy/trader/detail?uid=${uid}`)
              return await r2.json()
            }
            return await r.json()
          } catch { return null }
        }, uid)

        if (detail?.code === 200 && detail.data) {
          const d = detail.data
          let wr = d.winRate != null ? parseFloat(String(d.winRate)) : null
          if (wr != null && wr > 0 && wr <= 1) wr *= 100
          let mdd = d.mdd != null ? Math.abs(parseFloat(String(d.mdd))) : null
          traderData.set(uid, { winRate: wr, maxDrawdown: mdd })
        }
        await sleep(300)
      }
      console.log(`  Total: ${traderData.size}`)
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

async function main() {
  console.log('=== Multi-Platform Enrichment (Playwright) ===')
  console.log('Time:', new Date().toISOString())
  
  await enrichPhemex()
  await enrichCoinex()
  await enrichBlofin()
  
  console.log('\n=== All done ===')
}

main().catch(e => { console.error(e); process.exit(1) })
