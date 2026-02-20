#!/usr/bin/env node
/**
 * Debug: explore traderView API response to understand ID mapping
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
  // Get null traders
  const { data: snaps } = await sb.from('trader_snapshots')
    .select('source_trader_id, roi_7d, roi_30d')
    .eq('source', 'bitget_spot')
    .is('roi_7d', null)
    .limit(100)
  const nullTraderIds = [...new Set(snaps.map(s => s.source_trader_id))]
  console.log(`Null roi_7d traders (${nullTraderIds.length}): ${nullTraderIds.slice(0, 5).join(', ')}...`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  const page = await ctx.newPage()
  await ctx.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', r => r.abort())

  await page.goto('https://www.bitget.com/copy-trading/spot', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('Session ready.\n')

  // Fetch first page of 7d leaderboard to inspect structure
  console.log('=== Fetching 7d leaderboard page 1 ===')
  const result = await page.evaluate(async () => {
    try {
      const resp = await fetch('/v1/trace/spot/public/uta/traderView', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageNo: 1, pageSize: 20, sortRule: 2, sortFlag: 0,
          dataCycle: 7, fullStatus: 1, languageType: 0
        })
      })
      return { status: resp.status, data: await resp.json() }
    } catch(e) { return { error: e.toString() } }
  })

  if (result.error) { console.error('Error:', result.error); await browser.close(); return }
  console.log('Status:', result.status)
  console.log('Code:', result.data.code)

  if (result.data.data?.rows?.length > 0) {
    const sample = result.data.data.rows[0]
    console.log('\nFull sample row:')
    console.log(JSON.stringify(sample, null, 2))
    
    // Keys in the row
    console.log('\nAll keys:', Object.keys(sample).join(', '))

    // Check itemVoList
    if (sample.itemVoList) {
      console.log('\nitemVoList items:')
      for (const item of sample.itemVoList) {
        console.log(`  showColumnCode=${item.showColumnCode} comparedValue=${item.comparedValue}`)
      }
    }
  }

  // Fetch many pages and look for our traders
  console.log('\n\n=== Searching for our null traders across pages ===')
  const found = {}
  let matchCount = 0

  for (let page_no = 1; page_no <= 20; page_no++) {
    const r = await page.evaluate(async ({ page_no }) => {
      try {
        const resp = await fetch('/v1/trace/spot/public/uta/traderView', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pageNo: page_no, pageSize: 50, sortRule: 2, sortFlag: 0,
            dataCycle: 7, fullStatus: 1, languageType: 0
          })
        })
        return { status: resp.status, data: await resp.json() }
      } catch(e) { return { error: e.toString() } }
    }, { page_no })

    const rows = r.data?.data?.rows
    if (!rows?.length) {
      console.log(`Page ${page_no}: no rows`)
      break
    }

    for (const row of rows) {
      // Check all ID-like fields
      const traderUserId = row.traderUserId || row.traderId || row.userId || row.uid
      const nickname = row.nickname || row.nickName || row.displayName || row.name
      // Check if any field matches our null traders
      for (const nullId of nullTraderIds) {
        const rawId = nullId.replace(/^spot_/, '')
        if (traderUserId === nullId || traderUserId === rawId || 
            nickname === nullId || nickname === rawId ||
            row.traderUserId === nullId || row.traderUserId === rawId) {
          found[nullId] = { traderUserId, row: JSON.stringify(row).slice(0, 300) }
          matchCount++
        }
      }
    }

    if (page_no <= 2) {
      // For first 2 pages, print all IDs
      const ids = rows.map(r => r.traderUserId || r.traderId || r.userId || JSON.stringify(Object.keys(r)))
      console.log(`Page ${page_no}: ${rows.length} rows, first IDs: ${ids.slice(0, 5).join(', ')}`)
    } else {
      process.stdout.write(`Page ${page_no} (${rows.length} rows)... `)
    }
    await sleep(300)
  }
  console.log(`\n\nFound ${matchCount} matches: ${JSON.stringify(found, null, 2).slice(0, 1000)}`)

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
