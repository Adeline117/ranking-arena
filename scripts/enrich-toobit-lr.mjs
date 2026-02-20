#!/usr/bin/env node
/**
 * enrich-toobit-lr.mjs
 * Uses Playwright to intercept Toobit copy trading API and enrich leaderboard_ranks
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
const DELAY = 1500

async function main() {
  console.log('=== Toobit Leaderboard Enrichment ===')

  const { data: traders } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id')
    .eq('source', 'toobit')
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(500)

  console.log(`Traders to enrich: ${traders?.length || 0}`)
  if (!traders?.length) return

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  let updated = 0, failed = 0, noData = 0

  for (let i = 0; i < traders.length; i++) {
    const { id, source_trader_id } = traders[i]
    if (i % 20 === 0) console.log(`[${i}/${traders.length}] updated=${updated}`)

    let traderData = null
    const page = await context.newPage()

    try {
      // Intercept API responses
      page.on('response', async (resp) => {
        const url = resp.url()
        if ((url.includes('copy') || url.includes('trader')) && resp.status() === 200) {
          try {
            const json = await resp.json()
            // Look for trader detail data
            const d = json?.data || json?.result || json
            if (d?.winRate != null || d?.maxDrawdown != null || d?.tradeNum != null) {
              traderData = d
            }
            // Handle array responses
            if (Array.isArray(d)) {
              const found = d.find(t => String(t.uid || t.traderId || t.userId) === String(source_trader_id))
              if (found) traderData = found
            }
          } catch { /* skip */ }
        }
      })

      // Navigate to trader detail page
      await page.goto(
        `https://www.toobit.com/en-US/copy-trading/trader-detail?uid=${source_trader_id}`,
        { waitUntil: 'networkidle', timeout: 20000 }
      )
      await sleep(2000)

    } catch { /* timeout ok */ }
    
    await page.close()

    if (!traderData) {
      // Try direct API call with browser cookies
      try {
        const apiPage = await context.newPage()
        let captured = null
        apiPage.on('response', async (resp) => {
          if (resp.url().includes('capi.toobit.com') && resp.status() === 200) {
            try { captured = await resp.json() } catch { /* skip */ }
          }
        })
        await apiPage.goto(`https://www.toobit.com/en-US/copy-trading`, { waitUntil: 'domcontentloaded', timeout: 15000 })
        await sleep(1000)
        await apiPage.close()
        if (captured?.data) traderData = captured.data
      } catch { /* skip */ }
    }

    if (!traderData) { noData++; await sleep(DELAY); continue }

    // Extract fields - Toobit may use different field names
    const wr = traderData.winRate ?? traderData.win_rate ?? traderData.winRateRatio
    const mdd = traderData.maxDrawdown ?? traderData.max_drawdown ?? traderData.maxDrawdownRate
    const tc = traderData.tradeNum ?? traderData.totalTrades ?? traderData.trade_count

    if (!wr && !mdd && !tc) { noData++; await sleep(DELAY); continue }

    const updates = {}
    if (wr != null) {
      const wrVal = parseFloat(wr) > 1 ? parseFloat(wr) : parseFloat(wr) * 100
      if (!isNaN(wrVal) && wrVal >= 0 && wrVal <= 100) updates.win_rate = Math.round(wrVal * 100) / 100
    }
    if (mdd != null) {
      const mddVal = parseFloat(mdd) > 1 ? parseFloat(mdd) : parseFloat(mdd) * 100
      if (!isNaN(mddVal) && mddVal >= 0 && mddVal <= 100) updates.max_drawdown = Math.round(mddVal * 100) / 100
    }
    if (tc != null) {
      const tcVal = parseInt(tc)
      if (!isNaN(tcVal) && tcVal > 0) updates.trades_count = tcVal
    }

    if (Object.keys(updates).length === 0) { noData++; continue }

    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', id)
    if (error) failed++
    else updated++

    await sleep(DELAY)
  }

  await browser.close()

  const { count } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true })
    .eq('source', 'toobit').is('win_rate', null)
  console.log(`\nDone: updated=${updated} noData=${noData} failed=${failed}`)
  console.log(`Toobit WR null remaining: ${count}`)
}

main().catch(e => { console.error(e); process.exit(1) })
