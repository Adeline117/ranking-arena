#!/usr/bin/env node
/**
 * enrich-bitfinex-lr.mjs
 * Playwright-based enrichment for Bitfinex copy trading leaderboard.
 * Intercepts network requests to find trader stats API.
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('=== Bitfinex Leaderboard Enrichment ===')

  const { data: traders } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle')
    .eq('source', 'bitfinex')
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(300)

  console.log(`Bitfinex traders to enrich: ${traders?.length || 0}`)
  if (!traders?.length) return

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })

  // Phase 1: Scrape leaderboard page and intercept bulk data
  console.log('\nPhase 1: Intercepting Bitfinex copy trading API...')
  const capturedData = new Map() // handle/id -> stats
  const page = await context.newPage()

  page.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('copying') && resp.status() === 200) {
      try {
        const json = await resp.json()
        // Look for array of strategies/traders
        const items = Array.isArray(json) ? json :
          json?.data || json?.strategies || json?.traders || json?.result || []
        if (Array.isArray(items)) {
          items.forEach(item => {
            const key = item.nickname || item.name || item.id || item.strategy_id
            if (key) capturedData.set(String(key), item)
          })
          if (items.length > 0) console.log(`Captured ${items.length} items from ${url.split('?')[0]}`)
        }
      } catch { /* skip */ }
    }
  })

  try {
    await page.goto('https://trading.bitfinex.com/copytrading', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(5000)
    // Scroll to load more
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(3000)
  } catch { /* ok */ }
  await page.close()

  console.log(`Total captured from bulk: ${capturedData.size}`)

  let updated = 0, failed = 0, noData = 0

  // Try to match captured data to our traders
  for (const trader of traders) {
    const { id, source_trader_id, handle } = trader

    // Try to find in captured data
    let data = capturedData.get(source_trader_id) ||
      capturedData.get(handle) ||
      capturedData.get(String(handle)?.replace(/^TOP/, ''))

    if (data) {
      // Extract stats
      const wr = data.win_rate ?? data.winRate ?? data.winning_pct ?? data.winPercentage
      const mdd = data.max_drawdown ?? data.maxDrawdown ?? data.drawdown
      const tc = data.trades ?? data.total_trades ?? data.trade_count

      const updates = {}
      if (wr != null) {
        const v = parseFloat(wr) > 1 ? parseFloat(wr) : parseFloat(wr) * 100
        if (!isNaN(v) && v >= 0 && v <= 100) updates.win_rate = Math.round(v * 100) / 100
      }
      if (mdd != null) {
        const v = parseFloat(mdd) > 1 ? parseFloat(mdd) : parseFloat(mdd) * 100
        if (!isNaN(v) && v >= 0 && v <= 100) updates.max_drawdown = Math.round(v * 100) / 100
      }
      if (tc != null) {
        const v = parseInt(tc)
        if (!isNaN(v) && v > 0) updates.trades_count = v
      }

      if (Object.keys(updates).length > 0) {
        const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', id)
        if (error) failed++
        else updated++
      } else noData++
    } else {
      noData++
    }
  }

  await browser.close()

  const { count: remaining } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true })
    .eq('source', 'bitfinex').is('win_rate', null)

  console.log(`\nDone: updated=${updated} noData=${noData} failed=${failed}`)
  console.log(`Bitfinex WR null remaining: ${remaining}`)

  if (remaining && remaining > 0 && capturedData.size === 0) {
    console.log('ERROR: No data captured from Bitfinex API. The SPA might need different interception approach.')
    console.log('Suggestion: Try intercepting XHR requests to https://api-pub.bitfinex.com or trading.bitfinex.com/api')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
