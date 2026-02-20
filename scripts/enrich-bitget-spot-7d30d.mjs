#!/usr/bin/env node
/**
 * enrich-bitget-spot-7d30d.mjs
 * Enriches bitget_spot trader_snapshots with roi_7d, roi_30d.
 * 
 * Strategy:
 * - Process traders in batches of BROWSER_BATCH traders per browser instance
 * - For each batch: launch browser → navigate once to establish session → fetch API for all traders → close browser
 * - Uses in-page fetch() calls (authenticated with browser cookies)
 * - Skips traders already updated
 * - Handles 429 rate limits with retry + backoff
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
const BROWSER_BATCH = 50    // Restart browser every N traders
const DELAY_MS = 1000       // Delay between traders
const GAP_MS = 300          // Gap between 7d and 30d requests for same trader
const DRY_RUN = process.argv.includes('--dry-run')

async function fetchProfitRate(page, traderId, showDay, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let result
    try {
      result = await page.evaluate(async ({ traderId, showDay }) => {
        try {
          const resp = await fetch('https://www.bitget.com/v1/trace/spot/view/queryProfitRate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ languageType: 0, triggerUserId: traderId, showDay })
          })
          return { status: resp.status, ok: resp.ok, data: resp.ok ? await resp.json() : null }
        } catch(e) {
          return { error: e.toString() }
        }
      }, { traderId, showDay })
    } catch(e) {
      return { error: `page.evaluate failed: ${e.message}` }
    }
    
    if (result.error) return { error: result.error }
    if (result.status === 429) {
      await sleep((attempt + 1) * 4000)
      continue
    }
    if (!result.ok) return { error: `HTTP ${result.status}` }
    return result.data
  }
  return { error: '429 max retries' }
}

function computeROI(data) {
  if (!data?.data?.rows?.length) return null
  const rows = data.data.rows
  if (rows.length === 1) {
    const v = parseFloat(rows[0].amount)
    return isNaN(v) ? null : parseFloat(v.toFixed(2))
  }
  const first = parseFloat(rows[0].amount)
  const last = parseFloat(rows[rows.length - 1].amount)
  if (isNaN(first) || isNaN(last)) return null
  return parseFloat((last - first).toFixed(2))
}

async function processBatch(traders) {
  let updated = 0, noData = 0, errors = 0

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  await ctx.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot}', route => route.abort())
  const page = await ctx.newPage()

  // Establish session by navigating to a trader page
  const sessionTrader = traders[0].source_trader_id
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${sessionTrader}/spot`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    )
    await sleep(2500)
  } catch(e) {
    console.error(`  Failed to establish session: ${e.message.substring(0, 100)}`)
    await browser.close()
    return { updated: 0, noData: 0, errors: traders.length }
  }

  for (const snap of traders) {
    const traderId = snap.source_trader_id
    
    try {
      // Only fetch the period(s) we need
      const need7d = snap.roi_7d == null
      const need30d = snap.roi_30d == null
      
      let data7d = null, data30d = null
      
      if (need7d) {
        data7d = await fetchProfitRate(page, traderId, 1)
        if (need30d) await sleep(GAP_MS)
      }
      if (need30d) {
        data30d = await fetchProfitRate(page, traderId, 3)
      }

      // Check for errors
      const hasError = (need7d && data7d?.error) || (need30d && data30d?.error)
      if (hasError) {
        errors++
        await sleep(DELAY_MS * 2)
        continue
      }

      // Check API response codes
      if (need7d && data7d?.code !== '200') { noData++; await sleep(DELAY_MS); continue }

      const roi7 = need7d ? computeROI(data7d) : undefined
      const roi30 = need30d ? computeROI(data30d) : undefined

      if (roi7 == null && roi30 == null) { noData++; await sleep(DELAY_MS); continue }

      const updates = {}
      if (need7d && roi7 != null) updates.roi_7d = roi7
      if (need30d && roi30 != null) updates.roi_30d = roi30

      if (!Object.keys(updates).length) { noData++; await sleep(DELAY_MS); continue }

      if (!DRY_RUN) {
        const { error: updateErr } = await sb
          .from('trader_snapshots')
          .update(updates)
          .eq('source', 'bitget_spot')
          .eq('source_trader_id', traderId)
        
        if (updateErr) {
          console.error(`  Update err ${traderId}: ${updateErr.message}`)
          errors++
        } else {
          updated++
        }
      } else {
        console.log(`[DRY] ${traderId}: ${JSON.stringify(updates)}`)
        updated++
      }
    } catch(e) {
      errors++
      // If page is closed, bail from this batch
      if (e.message.includes('closed') || e.message.includes('detached')) {
        console.log(`  Browser crashed on ${traderId} - will retry this batch`)
        errors += traders.indexOf(snap) + 1
        break
      }
    }

    await sleep(DELAY_MS)
  }

  try { await browser.close() } catch {}
  return { updated, noData, errors }
}

async function main() {
  console.log(`=== Bitget Spot 7d/30d ROI Enrichment ===`)
  console.log(`DRY_RUN: ${DRY_RUN}, DELAY: ${DELAY_MS}ms, BROWSER_BATCH: ${BROWSER_BATCH}`)

  let totalUpdated = 0, totalNoData = 0, totalErrors = 0
  const startTime = Date.now()

  while (true) {
    // Fetch pending traders fresh each iteration
    const { data: snaps } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d')
      .eq('source', 'bitget_spot')
      .or('roi_7d.is.null,roi_30d.is.null')
      .order('source_trader_id')
      .limit(BROWSER_BATCH * 10) // Fetch more, deduplicate

    if (!snaps?.length) { console.log('All traders processed!'); break }

    // Deduplicate by trader ID
    const seen = new Set()
    const unique = snaps.filter(s => {
      if (seen.has(s.source_trader_id)) return false
      seen.add(s.source_trader_id)
      return s.source_trader_id?.length >= 10
    }).slice(0, BROWSER_BATCH)

    if (!unique.length) { console.log('No more traders to process'); break }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
    console.log(`\n[${elapsed}s] Processing batch of ${unique.length} traders (total updated: ${totalUpdated})`)

    const { updated, noData, errors } = await processBatch(unique)
    totalUpdated += updated
    totalNoData += noData
    totalErrors += errors

    console.log(`  Batch done: +${updated} updated, ${noData} noData, ${errors} errors`)

    if (updated === 0 && errors > noData) {
      console.log('Too many errors, waiting 30s before retry...')
      await sleep(30000)
    } else {
      await sleep(2000) // Brief pause between batches
    }
  }

  // Final count
  const { count: remaining } = await sb.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bitget_spot')
    .is('roi_7d', null)

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
  console.log(`\n=== Done in ${elapsed}min ===`)
  console.log(`Total updated: ${totalUpdated}`)
  console.log(`Total noData: ${totalNoData}`)
  console.log(`Total errors: ${totalErrors}`)
  console.log(`bitget_spot roi_7d null remaining: ${remaining}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
