#!/usr/bin/env node
/**
 * Bitget Futures & Spot Enrichment Script
 * 
 * For traders with valid hex IDs (b0b...), visits individual detail pages
 * to extract win_rate, max_drawdown, ROI, PnL.
 * Only UPDATEs NULL fields — never overwrites existing data.
 * 
 * Usage: node scripts/import/enrich_bitget_data.mjs [bitget_futures|bitget_spot|all]
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pLimit from 'p-limit'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  randomDelay,
} from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())
const supabase = getSupabaseClient()

const CONCURRENCY = 3

async function fetchTraderDetail(browser, traderId, type) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  let details = {}

  // Intercept API responses
  page.on('response', async (res) => {
    const url = res.url()
    try {
      if (url.includes('trader') && url.includes('api')) {
        const text = await res.text().catch(() => '')
        if (text.startsWith('{')) {
          try {
            const json = JSON.parse(text)
            const d = json.data
            if (d && typeof d === 'object') {
              if (d.winRate !== undefined) details.winRate = parseFloat(d.winRate)
              if (d.maxDrawDown !== undefined) details.maxDrawdown = parseFloat(d.maxDrawDown)
              if (d.maxDrawdown !== undefined) details.maxDrawdown = parseFloat(d.maxDrawdown)
              if (d.totalProfit !== undefined) details.pnl = parseFloat(d.totalProfit)
              if (d.totalProfitUsdt !== undefined) details.pnl = parseFloat(d.totalProfitUsdt)
              if (d.roi !== undefined) details.roi = parseFloat(d.roi)
              if (d.yieldRate !== undefined) details.roi = parseFloat(d.yieldRate)
              if (d.totalTrades !== undefined) details.tradesCount = parseInt(d.totalTrades)
              if (d.tradeCount !== undefined) details.tradesCount = parseInt(d.tradeCount)
            }
          } catch {}
        }
      }
    } catch {}
  })

  try {
    const suffix = type === 'spot' ? 'spot' : 'futures'
    const url = `https://www.bitget.com/copy-trading/trader/${traderId}/${suffix}`
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {})

    await Promise.race([
      page.waitForSelector('[class*="roi"], [class*="ROI"]', { timeout: 8000 }),
      sleep(4000),
    ]).catch(() => {})

    // Extract from DOM
    const pageData = await page.evaluate(() => {
      const text = document.body.innerText
      const result = {}

      const roiMatch = text.match(/ROI[\s\n:]*([+-]?[\d,]+\.?\d*)%/i)
      if (roiMatch) result.roi = parseFloat(roiMatch[1].replace(/,/g, ''))

      const pnlMatch = text.match(/(?:Total P&?L|总收益|Profit)[\s\n:]*\$?([\d,]+\.?\d*)/i)
      if (pnlMatch) result.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))

      const winMatch = text.match(/(?:Win rate|胜率)[\s\n:]*(\d+\.?\d*)%/i)
      if (winMatch) result.winRate = parseFloat(winMatch[1])

      const mddMatch = text.match(/(?:MDD|Max(?:imum)? Drawdown|最大回撤)[\s\n:]*(\d+\.?\d*)%/i)
      if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])

      const tradesMatch = text.match(/(?:Total trades|总交易数|Trades?)[\s\n:]*(\d+)/i)
      if (tradesMatch) result.tradesCount = parseInt(tradesMatch[1])

      return result
    })

    // Merge: API data takes priority, DOM fills gaps
    for (const [k, v] of Object.entries(pageData)) {
      if (details[k] === undefined || details[k] === null) {
        details[k] = v
      }
    }
  } catch {}
  finally {
    await page.close()
  }

  return details
}

async function enrichSource(source, period) {
  const type = source.includes('spot') ? 'spot' : 'futures'
  console.log(`\n=== Enriching ${source} ${period} ===`)

  // 1. Get existing traders needing enrichment
  const { data: existing, error: dbErr } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, arena_score')
    .eq('source', source)
    .eq('season_id', period)

  if (dbErr) { console.error('DB error:', dbErr.message); return }

  // Filter: only hex IDs and only those missing data
  const needsEnrichment = existing.filter(t => {
    const isHexId = /^[a-f0-9]{16,}$/i.test(t.source_trader_id)
    if (!isHexId) return false
    return t.win_rate === null || t.max_drawdown === null ||
           t.roi === null || t.roi === 0 || t.trades_count === null
  })

  console.log(`  ${existing.length} total, ${needsEnrichment.length} enrichable (hex IDs with missing data)`)

  if (needsEnrichment.length === 0) {
    console.log('  ✅ Nothing to enrich!')
    return
  }

  // 2. Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  })

  const limit = pLimit(CONCURRENCY)
  let completed = 0
  let updated = 0
  const total = needsEnrichment.length
  const startTime = Date.now()

  try {
    const tasks = needsEnrichment.map(snap =>
      limit(async () => {
        await randomDelay(200, 600)

        const details = await fetchTraderDetail(browser, snap.source_trader_id, type)
        completed++

        if (completed % 10 === 0 || completed === total) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(`  Progress: ${completed}/${total} | ${elapsed}s | updated: ${updated}`)
        }

        // Build update object (only NULL fields)
        const updates = {}
        if ((snap.roi === null || snap.roi === 0) && details.roi != null) {
          updates.roi = details.roi > 0 && details.roi < 5 ? details.roi * 100 : details.roi
        }
        if ((snap.pnl === null || snap.pnl === 0) && details.pnl != null) {
          updates.pnl = details.pnl
        }
        if (snap.win_rate === null && details.winRate != null) {
          updates.win_rate = details.winRate > 0 && details.winRate <= 1 ? details.winRate * 100 : details.winRate
        }
        if (snap.max_drawdown === null && details.maxDrawdown != null) {
          updates.max_drawdown = Math.abs(details.maxDrawdown)
        }
        if (snap.trades_count === null && details.tradesCount != null) {
          updates.trades_count = details.tradesCount
        }

        if (Object.keys(updates).length === 0) return

        // Recalculate arena_score
        const newRoi = updates.roi ?? snap.roi ?? 0
        const newPnl = updates.pnl ?? snap.pnl ?? 0
        const newWr = updates.win_rate ?? snap.win_rate ?? null
        const newMdd = updates.max_drawdown ?? snap.max_drawdown ?? null
        const { totalScore } = calculateArenaScore(newRoi, newPnl, newMdd, newWr, period)
        updates.arena_score = totalScore

        const { error } = await supabase
          .from('trader_snapshots')
          .update(updates)
          .eq('id', snap.id)

        if (!error) updated++
      })
    )

    await Promise.all(tasks)
  } finally {
    await browser.close()
  }

  console.log(`  ✅ Updated ${updated}/${total} snapshots`)
}

async function main() {
  const arg = process.argv[2]?.toLowerCase() || 'all'
  const sources = arg === 'all' ? ['bitget_futures', 'bitget_spot'] : [arg]
  const periods = ['90D', '30D', '7D']

  for (const source of sources) {
    for (const period of periods) {
      await enrichSource(source, period)
    }
  }

  console.log('\n=== Done ===')
}

main().catch(console.error)
