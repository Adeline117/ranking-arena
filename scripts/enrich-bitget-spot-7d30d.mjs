#!/usr/bin/env node
/**
 * enrich-bitget-spot-7d30d.mjs
 * Enriches bitget_spot trader_snapshots with roi_7d, roi_30d using Playwright.
 * Intercepts traderDetailPage API which has all trader stats including weekly/monthly roi.
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

async function getTraderStats(page, traderId) {
  let detail = null
  const handler = async (resp) => {
    if (resp.status() !== 200) return
    const url = resp.url()
    if (url.includes('traderDetailPage') || url.includes('copy-trading/profit') || url.includes('spotTrader')) {
      try {
        const json = await resp.json()
        if (json?.data) detail = json
      } catch {}
    }
  }
  page.on('response', handler)
  try {
    await page.goto(`https://www.bitget.com/copy-trading/trader/${traderId}/spot`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    for (let i = 0; i < 15; i++) { if (detail) break; await sleep(300) }
  } catch {}
  page.removeListener('response', handler)
  return detail
}

function extractData(detail) {
  if (!detail?.data) return null
  const allData = detail.data?.traderDataVo?.allData || detail.data?.allData || detail.data
  if (!allData) return null

  // Log ALL keys to understand structure
  console.log('  Available keys:', Object.keys(allData).filter(k => k.toLowerCase().includes('roi') || k.toLowerCase().includes('profit') || k.toLowerCase().includes('week') || k.toLowerCase().includes('month') || k.toLowerCase().includes('7') || k.toLowerCase().includes('30')).join(', '))

  // Try multiple field name patterns
  const roi7 = allData.sevenDayROI ?? allData.weekROI ?? allData.roi7d ?? allData.roiWeek ?? allData['7DayROI'] ?? allData.d7Roi ?? allData.d7roi
  const roi30 = allData.thirtyDayROI ?? allData.monthROI ?? allData.roi30d ?? allData.roiMonth ?? allData['30DayROI'] ?? allData.d30Roi ?? allData.d30roi
  const pnl7 = allData.sevenDayProfit ?? allData.weekProfit ?? allData.pnl7d ?? allData.d7Pnl
  const pnl30 = allData.thirtyDayProfit ?? allData.monthProfit ?? allData.pnl30d ?? allData.d30Pnl

  return { roi7, roi30, pnl7, pnl30, allData }
}

async function main() {
  console.log('=== Bitget Spot 7d/30d ROI Enrichment ===')

  // Get snapshots with null roi_7d
  const { data: snaps } = await sb
    .from('trader_snapshots')
    .select('id, source_trader_id, roi_7d, roi_30d')
    .eq('source', 'bitget_spot')
    .is('roi_7d', null)
    .limit(300)

  console.log(`Snapshots to process: ${snaps?.length || 0}`)
  if (!snaps?.length) { console.log('Nothing to do'); return }

  // Deduplicate by trader ID
  const seen = new Set()
  const unique = snaps.filter(s => { if (seen.has(s.source_trader_id)) return false; seen.add(s.source_trader_id); return true })
  console.log(`Unique traders: ${unique.length}`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  await ctx.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', route => route.abort())
  const page = await ctx.newPage()

  let updated = 0, noData = 0, first3 = 0

  for (let i = 0; i < unique.length; i++) {
    const snap = unique[i]
    if (i % 20 === 0) console.log(`[${i}/${unique.length}] updated=${updated}`)

    const detail = await getTraderStats(page, snap.source_trader_id)
    if (!detail) { noData++; continue }

    const extracted = extractData(detail)

    // First 3 traders: print ALL keys for debugging
    if (first3 < 3 && extracted?.allData) {
      console.log(`\n=== DEBUG trader ${snap.source_trader_id} ===`)
      console.log('All keys:', JSON.stringify(Object.keys(extracted.allData)))
      console.log('Sample values:', JSON.stringify(Object.fromEntries(Object.entries(extracted.allData).slice(0, 20))))
      first3++
    }

    if (!extracted || (extracted.roi7 == null && extracted.roi30 == null)) {
      noData++
      continue
    }

    const updates = {}
    if (extracted.roi7 != null) {
      const v = parseFloat(extracted.roi7)
      if (!isNaN(v)) updates.roi_7d = v > 10 ? v : v * 100 // handle decimal vs percent
    }
    if (extracted.roi30 != null) {
      const v = parseFloat(extracted.roi30)
      if (!isNaN(v)) updates.roi_30d = v > 10 ? v : v * 100
    }
    if (extracted.pnl7 != null) updates.pnl_7d = parseFloat(extracted.pnl7)
    if (extracted.pnl30 != null) updates.pnl_30d = parseFloat(extracted.pnl30)

    if (Object.keys(updates).length === 0) { noData++; continue }

    // Update all matching snapshots for this trader
    const { error } = await sb.from('trader_snapshots').update(updates)
      .eq('source', 'bitget_spot').eq('source_trader_id', snap.source_trader_id)
    if (error) console.error('update err:', error.message)
    else updated++
  }

  await browser.close()

  const { count: remaining } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true })
    .eq('source', 'bitget_spot').is('roi_7d', null)
  console.log(`\nDone: updated=${updated} noData=${noData}`)
  console.log(`bitget_spot roi_7d null remaining: ${remaining}`)
}

main().catch(e => { console.error(e); process.exit(1) })
