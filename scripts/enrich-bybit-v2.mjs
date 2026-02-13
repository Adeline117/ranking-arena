#!/usr/bin/env node
/**
 * Enrich bybit leaderboard_ranks using puppeteer-stealth
 * Uses page.goto to fetch each API URL directly (avoids in-page fetch blocking)
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
  const ddRaw = result[pfx + 'DrawDownE4']
  const ddE4 = ddRaw != null ? parseInt(ddRaw) : null
  return {
    win_rate: wrE4 > 0 ? wrE4 / 100 : (totalTrades > 0 ? parseFloat((winCount / totalTrades * 100).toFixed(2)) : null),
    max_drawdown: ddE4 != null ? ddE4 / 100 : null,
    trades_count: totalTrades > 0 ? totalTrades : null,
  }
}

async function main() {
  console.log('=== Bybit enrichment v2 (page.goto approach) ===')

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

  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  // Filter to valid leaderMarks (base64-like with ==, +, / or long alphanumeric)
  const isValidMark = id => id.includes('==') || id.includes('+') || id.includes('/') || (id.length > 15 && !/^\d+$/.test(id))
  const allTraders = [...byTrader.keys()]
  const traders = allTraders.filter(isValidMark)
  console.log(`Unique traders: ${allTraders.length} (${traders.length} valid leaderMarks, ${allTraders.length - traders.length} skipped)`)

  // Launch browser
  console.log('Launching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })

  let page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  // Visit bybit first to establish cookies
  console.log('Visiting bybit.com...')
  try {
    await page.goto('https://www.bybit.com/copyTrading/traderRanking', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(3000)
  } catch {}

  let updated = 0, skipped = 0, apiErr = 0, consecutiveErr = 0
  const startTime = Date.now()

  for (let i = 0; i < traders.length; i++) {
    const traderId = traders[i]
    const rows = byTrader.get(traderId)

    try {
      const apiUrl = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(traderId)}`
      
      const response = await page.goto(apiUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })
      const text = await page.evaluate(() => document.body?.innerText || '')
      
      if (!text || text.startsWith('<') || response.status() === 403) {
        apiErr++
        consecutiveErr++
        
        if (consecutiveErr >= 5) {
          console.log(`  ${consecutiveErr} consecutive errors at ${i}, refreshing browser context...`)
          await page.close().catch(() => {})
          page = await browser.newPage()
          await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
          try {
            await page.goto('https://www.bybit.com/copyTrading/traderRanking', { waitUntil: 'domcontentloaded', timeout: 20000 })
            await sleep(5000)
          } catch {}
          consecutiveErr = 0
        }
        await sleep(1000)
        continue
      }

      let json
      try { json = JSON.parse(text) } catch { apiErr++; consecutiveErr++; continue }

      if (json.retCode !== 0) { apiErr++; consecutiveErr++; continue }

      consecutiveErr = 0
      const result = json.result

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
      consecutiveErr++
      if (e.message?.includes('timeout')) {
        // Page navigation timeout - try refreshing
        if (consecutiveErr >= 3) {
          console.log(`  Timeout at ${i}, new page...`)
          await page.close().catch(() => {})
          page = await browser.newPage()
          await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
          try {
            await page.goto('https://www.bybit.com/copyTrading/traderRanking', { waitUntil: 'domcontentloaded', timeout: 20000 })
            await sleep(3000)
          } catch {}
          consecutiveErr = 0
        }
      }
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
