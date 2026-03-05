#!/usr/bin/env node
/**
 * Debug: test Bitget spot API with actual trader IDs
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
  // Get a few sample traders
  const { data: snaps } = await sb.from('trader_snapshots')
    .select('source_trader_id, roi_7d, roi_30d')
    .eq('source', 'bitget_spot')
    .is('roi_7d', null)
    .limit(3)

  const uniqueTraders = [...new Set(snaps.map(s => s.source_trader_id))].slice(0, 3)
  console.log('Sample trader IDs:', uniqueTraders)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  await ctx.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot}', r => r.abort())
  const page = await ctx.newPage()

  // Navigate to establish session
  const testTrader = uniqueTraders[0]
  console.log(`\nNavigating to copy-trading/spot-trader/${testTrader}...`)
  try {
    // Try various URL patterns
    await page.goto('https://www.bitget.com/copy-trading/spot', {
      waitUntil: 'domcontentloaded', timeout: 30000
    })
    await sleep(3000)
    console.log('Current URL:', page.url())
  } catch(e) {
    console.log('Nav error:', e.message.slice(0, 100))
  }

  for (const traderId of uniqueTraders) {
    console.log(`\n=== Testing trader: ${traderId} ===`)

    // Test 1: Original endpoint with showDay
    console.log('--- Test 1: /v1/trace/spot/view/queryProfitRate showDay=1 ---')
    const r1 = await page.evaluate(async ({ traderId }) => {
      try {
        const resp = await fetch('/v1/trace/spot/view/queryProfitRate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageType: 0, triggerUserId: traderId, showDay: 1 })
        })
        const text = await resp.text()
        return { status: resp.status, text: text.slice(0, 500) }
      } catch(e) { return { error: e.toString() } }
    }, { traderId })
    console.log('Result:', JSON.stringify(r1))

    // Test 2: cycleData endpoint (like futures) with cycleTime 7
    console.log('--- Test 2: /v1/trigger/trace/public/cycleData cycleTime=7 ---')
    const r2 = await page.evaluate(async ({ traderId }) => {
      try {
        const resp = await fetch('/v1/trigger/trace/public/cycleData', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageType: 0, triggerUserId: traderId, cycleTime: 7 })
        })
        const text = await resp.text()
        return { status: resp.status, text: text.slice(0, 500) }
      } catch(e) { return { error: e.toString() } }
    }, { traderId })
    console.log('Result:', JSON.stringify(r2))

    // Test 3: spot cycleData endpoint
    console.log('--- Test 3: /v1/trigger/trace/public/spot/cycleData cycleTime=7 ---')
    const r3 = await page.evaluate(async ({ traderId }) => {
      try {
        const resp = await fetch('/v1/trigger/trace/public/spot/cycleData', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageType: 0, triggerUserId: traderId, cycleTime: 7 })
        })
        const text = await resp.text()
        return { status: resp.status, text: text.slice(0, 500) }
      } catch(e) { return { error: e.toString() } }
    }, { traderId })
    console.log('Result:', JSON.stringify(r3))

    // Test 4: Try stripping "spot_" prefix and using as traderId
    const rawId = traderId.replace(/^spot_/, '')
    console.log(`--- Test 4: raw ID=${rawId} with /v1/trigger/trace/public/cycleData ---`)
    const r4 = await page.evaluate(async ({ rawId }) => {
      try {
        const resp = await fetch('/v1/trigger/trace/public/cycleData', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageType: 0, triggerUserId: rawId, cycleTime: 7 })
        })
        const text = await resp.text()
        return { status: resp.status, text: text.slice(0, 500) }
      } catch(e) { return { error: e.toString() } }
    }, { rawId })
    console.log('Result:', JSON.stringify(r4))

    await sleep(500)
  }

  await browser.close()
  console.log('\n=== Debug complete ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
