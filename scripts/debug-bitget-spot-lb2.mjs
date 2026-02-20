#!/usr/bin/env node
/**
 * Debug: test Bitget spot leaderboard API via Playwright browser context
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
  console.log('=== Bitget Spot Leaderboard Debug ===\n')

  // Get unique null trader IDs from DB
  const { data: snaps } = await sb.from('trader_snapshots')
    .select('source_trader_id, roi_7d, roi_30d')
    .eq('source', 'bitget_spot')
    .is('roi_7d', null)
    .limit(10)
  const nullTraders = [...new Set(snaps.map(s => s.source_trader_id))]
  console.log(`Traders with null roi_7d: ${nullTraders.slice(0, 5).join(', ')}...`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  await ctx.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', r => r.abort())
  const page = await ctx.newPage()

  // Navigate to establish session
  await page.goto('https://www.bitget.com/copy-trading/spot', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('Session established.\n')

  // Test the leaderboard API for 7d (sortType=1)
  console.log('--- Testing /v1/copy/spot/trader/list sortType=1 (7d) ---')
  const lb7d = await page.evaluate(async () => {
    try {
      const resp = await fetch('/v1/copy/spot/trader/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageNo: 1, pageSize: 5, sortField: 'ROI', sortType: 1 })
      })
      return { status: resp.status, data: await resp.json() }
    } catch(e) { return { error: e.toString() } }
  })
  console.log(JSON.stringify(lb7d, null, 2).slice(0, 2000))

  await sleep(1000)

  // Test the leaderboard API for 30d (sortType=2)
  console.log('\n--- Testing /v1/copy/spot/trader/list sortType=2 (30d) ---')
  const lb30d = await page.evaluate(async () => {
    try {
      const resp = await fetch('/v1/copy/spot/trader/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageNo: 1, pageSize: 5, sortField: 'ROI', sortType: 2 })
      })
      return { status: resp.status, data: await resp.json() }
    } catch(e) { return { error: e.toString() } }
  })
  console.log(JSON.stringify(lb30d, null, 2).slice(0, 1000))

  // If we got traders, check if their IDs match our null traders
  if (lb7d.data?.data?.list) {
    const apiIds = lb7d.data.data.list.map(t => t.traderId)
    console.log('\nAPI trader IDs (7d):', apiIds)
    const matches = apiIds.filter(id => nullTraders.includes(id))
    console.log('Matches with null traders:', matches)

    // What does a full trader entry look like?
    console.log('\nSample entry:', JSON.stringify(lb7d.data.data.list[0], null, 2))
  }

  // Test trader detail endpoint
  console.log('\n--- Testing /v1/copy/spot/trader/detail ---')
  const testId = nullTraders[0]
  const detail = await page.evaluate(async ({ traderId }) => {
    try {
      const resp = await fetch(`/v1/copy/spot/trader/detail?traderId=${traderId}`)
      return { status: resp.status, data: await resp.json() }
    } catch(e) { return { error: e.toString() } }
  }, { traderId: testId })
  console.log(`Detail for ${testId}:`, JSON.stringify(detail, null, 2).slice(0, 1000))

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
