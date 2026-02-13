#!/usr/bin/env node
/**
 * Enrich bybit leaderboard_ranks using puppeteer-stealth to bypass WAF
 * Fills: win_rate, max_drawdown, trades_count
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PERIOD_PREFIX = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }

function extractPeriodStats(result, seasonId) {
  const pfx = PERIOD_PREFIX[seasonId]
  if (!pfx) return null
  const winCount = parseInt(result[pfx + 'WinCount'] || '0')
  const lossCount = parseInt(result[pfx + 'LossCount'] || '0')
  const totalTrades = winCount + lossCount
  const wrE4 = parseInt(result[pfx + 'ProfitWinRateE4'] || '0')
  const ddE4 = parseInt(result[pfx + 'DrawDownE4'] || '0')
  return {
    win_rate: wrE4 > 0 ? wrE4 / 100 : (totalTrades > 0 ? parseFloat((winCount / totalTrades * 100).toFixed(2)) : null),
    max_drawdown: ddE4 > 0 ? ddE4 / 100 : null,
    trades_count: totalTrades > 0 ? totalTrades : null,
  }
}

async function main() {
  console.log('=== Bybit enrichment via Puppeteer-stealth ===')

  // Get all rows needing enrichment
  let allRows = []
  let from = 0
  while (true) {
    const { data } = await sb.from('leaderboard_ranks')
      .select('id,source_trader_id,season_id,win_rate,max_drawdown,trades_count')
      .eq('source', 'bybit')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(from, from + 999)
    if (!data || data.length === 0) break
    allRows.push(...data)
    from += 1000
    if (data.length < 1000) break
  }

  console.log(`Total rows needing enrichment: ${allRows.length}`)

  // Group by trader
  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const traders = [...byTrader.keys()]
  console.log(`Unique traders: ${traders.length}`)

  // Launch browser
  console.log('Launching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })

  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  // Visit bybit first to get cookies
  console.log('Visiting bybit.com to get cookies...')
  try {
    await page.goto('https://www.bybit.com/copyTrading/traderRanking', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(3000)
    console.log('Page loaded, cookies set')
  } catch (e) {
    console.log('Warning: page load issue:', e.message?.substring(0, 80))
  }

  let updated = 0, skipped = 0, apiErr = 0
  const startTime = Date.now()

  for (let i = 0; i < traders.length; i++) {
    const traderId = traders[i]
    const rows = byTrader.get(traderId)

    // Refresh page every 200 traders to reset cookies/state
    if (i > 0 && i % 200 === 0) {
      console.log('  Refreshing page...')
      try {
        await page.goto('https://www.bybit.com/copyTrading/traderRanking', { waitUntil: 'domcontentloaded', timeout: 20000 })
        await sleep(2000)
      } catch {}
    }

    try {
      const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(traderId)}`
      
      const response = await Promise.race([
        page.evaluate(async (fetchUrl) => {
          try {
            const res = await fetch(fetchUrl)
            if (!res.ok) return { error: res.status }
            return await res.json()
          } catch (e) {
            return { error: e.message }
          }
        }, url),
        sleep(10000).then(() => ({ error: 'timeout' }))
      ])

      if (response.error || response.retCode !== 0) {
        apiErr++
        if (response.error === 'timeout' || response.error === 403) {
          // Try refreshing the page
          if (apiErr % 5 === 0) {
            console.log(`  WAF/timeout at ${i}, refreshing...`)
            try {
              await page.goto('https://www.bybit.com/copyTrading/traderRanking', { waitUntil: 'domcontentloaded', timeout: 20000 })
              await sleep(3000)
            } catch {}
          }
        }
        if (apiErr > 50 && apiErr > (i + 1) * 0.4) {
          console.log('Too many errors, stopping.')
          break
        }
        await sleep(500)
        continue
      }

      const result = response.result
      for (const row of rows) {
        const stats = extractPeriodStats(result, row.season_id)
        if (!stats) { skipped++; continue }

        const update = {}
        if (row.win_rate == null && stats.win_rate != null) update.win_rate = stats.win_rate
        if (row.max_drawdown == null && stats.max_drawdown != null) update.max_drawdown = stats.max_drawdown
        if (row.trades_count == null && stats.trades_count != null) update.trades_count = stats.trades_count

        if (Object.keys(update).length === 0) { skipped++; continue }

        const { error } = await sb.from('leaderboard_ranks').update(update).eq('id', row.id)
        if (error) { console.log(`  ⚠ ${row.id}: ${error.message}`); continue }
        updated++
      }
    } catch (e) {
      apiErr++
      console.log(`  err: ${e.message?.substring(0, 60)}`)
    }

    await sleep(400)

    if ((i + 1) % 50 === 0 || i === traders.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      console.log(`  [${i + 1}/${traders.length}] updated=${updated} skipped=${skipped} err=${apiErr} | ${elapsed}m`)
    }
  }

  await browser.close()

  console.log(`\n=== Done ===`)
  console.log(`Updated: ${updated}`)
  console.log(`Skipped: ${skipped}`)
  console.log(`API errors: ${apiErr}`)
}

main().catch(console.error)
