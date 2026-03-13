#!/usr/bin/env node

// Bybit Detail Page PnL Scraper
// Bybit leaderboard API doesn't expose trader PnL. Uses Playwright
// to open each trader's profile page and extract PnL from DOM.
//
// Usage: node bybit-detail-pnl.mjs [--limit=200] [--concurrency=3] [--period=30D]
// Deploy: scp to VPS, add to crontab every 6h
// Requires: playwright, @supabase/supabase-js, dotenv

import 'dotenv/config'

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '200')
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '3')
const PERIOD = process.argv.find(a => a.startsWith('--period='))?.split('=')[1] || '30D'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Profile page URL template
const PROFILE_URL = (mark) =>
  `https://www.bybitglobal.com/en/copy-trading/leader-detail?leaderMark=${encodeURIComponent(mark)}`

async function getTopTraders() {
  // Get top traders by arena_score that have NULL pnl
  const { data, error } = await supabase
    .from('trader_snapshots_v2')
    .select('trader_key, roi_pct, arena_score')
    .eq('platform', 'bybit')
    .eq('window', PERIOD)
    .not('roi_pct', 'is', null)
    .is('pnl_usd', null)
    .order('arena_score', { ascending: false })
    .limit(LIMIT)

  if (error) {
    console.error('Failed to fetch traders:', error.message)
    return []
  }
  return data || []
}

async function scrapeTraderPnl(page, traderKey) {
  try {
    await page.goto(PROFILE_URL(traderKey), { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(3000) // Wait for SPA to render

    // Try to find PnL value on the page
    // Bybit profile pages typically show PnL in a section with metrics
    const pnlSelectors = [
      // Common patterns on Bybit copy trading profile pages
      '[class*="pnl"] [class*="value"]',
      '[class*="profit"] [class*="amount"]',
      '[data-testid*="pnl"]',
      '[class*="leadDetail"] [class*="totalPnl"]',
    ]

    // Also try intercepting API calls that the page makes
    const apiPnl = await page.evaluate(() => {
      // Check if there's any data in window.__NEXT_DATA__ or similar
      const nextData = window.__NEXT_DATA__
      if (nextData?.props?.pageProps) {
        const props = nextData.props.pageProps
        // Look for PnL in various common locations
        const pnl = props.pnl || props.totalPnl || props.leaderDetail?.pnl
        if (pnl != null) return Number(pnl)
      }
      return null
    })

    if (apiPnl != null) {
      return { traderKey, pnl: apiPnl, source: 'nextdata' }
    }

    // Fallback: try to find PnL text in the DOM
    for (const selector of pnlSelectors) {
      try {
        const el = await page.$(selector)
        if (el) {
          const text = await el.textContent()
          const cleaned = text?.replace(/[,$\s]/g, '').replace(/[+]/g, '')
          const num = parseFloat(cleaned || '')
          if (!isNaN(num)) {
            return { traderKey, pnl: num, source: `dom:${selector}` }
          }
        }
      } catch { /* selector not found */ }
    }

    // Last resort: search all visible text for PnL-like numbers near "PnL" label
    const pageText = await page.evaluate(() => document.body.innerText)
    const pnlMatch = pageText.match(/(?:PnL|Profit|P&L)[^\d-]*([+-]?[\d,]+\.?\d*)/i)
    if (pnlMatch) {
      const num = parseFloat(pnlMatch[1].replace(/,/g, ''))
      if (!isNaN(num)) {
        return { traderKey, pnl: num, source: 'text-search' }
      }
    }

    return { traderKey, pnl: null, source: 'not-found' }
  } catch (err) {
    return { traderKey, pnl: null, source: `error:${err.message}` }
  }
}

async function updatePnl(traderKey, pnl) {
  const { error } = await supabase
    .from('trader_snapshots_v2')
    .update({ pnl_usd: pnl })
    .eq('platform', 'bybit')
    .eq('trader_key', traderKey)
    .is('pnl_usd', null)

  if (error) {
    console.error(`  Failed to update ${traderKey}: ${error.message}`)
  }
}

async function main() {
  console.log(`=== Bybit Detail PnL Scraper ===`)
  console.log(`Limit: ${LIMIT}, Concurrency: ${CONCURRENCY}, Period: ${PERIOD}`)

  const traders = await getTopTraders()
  console.log(`Found ${traders.length} traders needing PnL`)

  if (traders.length === 0) {
    console.log('No traders to process')
    return
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  let success = 0
  let failed = 0

  // Process in batches of CONCURRENCY
  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    const batch = traders.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (trader) => {
        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        })
        const page = await context.newPage()
        try {
          const result = await scrapeTraderPnl(page, trader.trader_key)
          return result
        } finally {
          await context.close()
        }
      })
    )

    for (const result of results) {
      if (result.pnl != null) {
        await updatePnl(result.traderKey, result.pnl)
        success++
        console.log(`  ✅ ${result.traderKey}: PnL=${result.pnl} (${result.source})`)
      } else {
        failed++
        if (failed <= 10) {
          console.log(`  ❌ ${result.traderKey}: ${result.source}`)
        }
      }
    }

    // Progress
    const total = i + batch.length
    console.log(`Progress: ${total}/${traders.length} (${success} success, ${failed} failed)`)

    // Rate limit
    if (i + CONCURRENCY < traders.length) {
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  await browser.close()
  console.log(`\n=== Done: ${success} PnL values scraped, ${failed} failed ===`)
}

main().catch(console.error)
