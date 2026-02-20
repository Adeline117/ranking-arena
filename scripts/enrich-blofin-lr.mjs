#!/usr/bin/env node
/**
 * enrich-blofin-lr.mjs
 * Uses Playwright to bypass Cloudflare and enrich Blofin leaderboard_ranks
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
const DELAY = 2000

async function main() {
  console.log('=== Blofin Leaderboard Enrichment ===')

  const { data: traders } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id')
    .eq('source', 'blofin')
    .is('win_rate', null)
    .limit(300)

  console.log(`Blofin traders to enrich: ${traders?.length || 0}`)
  if (!traders?.length) return

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'application/json, text/plain, */*',
    },
  })

  // First warm up — visit Blofin home to get Cloudflare cookies
  console.log('Warming up Cloudflare cookies...')
  const warmPage = await context.newPage()
  try {
    await warmPage.goto('https://blofin.com/copy-trading', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)
  } catch { /* ok */ }
  await warmPage.close()
  console.log('Cookie warmup done')

  let updated = 0, failed = 0, noData = 0

  for (let i = 0; i < traders.length; i++) {
    const { id, source_trader_id } = traders[i]
    if (i % 20 === 0) console.log(`[${i}/${traders.length}] updated=${updated}`)

    let traderData = null
    const page = await context.newPage()

    try {
      page.on('response', async (resp) => {
        const url = resp.url()
        if (url.includes('blofin.com') && url.includes('copy') && resp.status() === 200) {
          try {
            const json = await resp.json()
            const d = json?.data || json?.result || json
            if (d?.winRate != null || d?.maxDrawDown != null || d?.winningRate != null) {
              traderData = d
            }
          } catch { /* skip */ }
        }
      })

      await page.goto(
        `https://blofin.com/copy-trading/lead-trader/${source_trader_id}`,
        { waitUntil: 'networkidle', timeout: 25000 }
      )
      await sleep(2500)
    } catch { /* ok */ }

    await page.close()

    if (!traderData) { noData++; await sleep(DELAY); continue }

    const wr = traderData.winRate ?? traderData.winningRate ?? traderData.win_rate
    const mdd = traderData.maxDrawDown ?? traderData.maxDrawdown ?? traderData.max_drawdown
    const tc = traderData.tradeNum ?? traderData.totalTrade ?? traderData.tradesCount

    if (!wr && !mdd && !tc) { noData++; continue }

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
    .eq('source', 'blofin').is('win_rate', null)
  console.log(`\nDone: updated=${updated} noData=${noData} failed=${failed}`)
  console.log(`Blofin WR null remaining: ${count}`)
}

main().catch(e => { console.error(e); process.exit(1) })
