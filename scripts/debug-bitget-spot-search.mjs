#!/usr/bin/env node
/**
 * Debug: search for our traders in the leaderboard by scanning through pages
 * Also try the spot search API
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
  
  // Create lookup sets - strip "spot_" prefix for matching
  const rawIds = new Set(nullTraderIds.map(id => id.replace(/^spot_/, '').toLowerCase()))
  const bgUserIds = new Map()
  // spot_bguser1psvkjrp -> BGUSER-1PSVKJRP  
  for (const id of nullTraderIds) {
    const raw = id.replace(/^spot_/, '')
    if (raw.startsWith('bguser')) {
      // bguser1psvkjrp -> BGUSER-1PSVKJRP
      bgUserIds.set(raw.toLowerCase(), `BGUSER-${raw.slice(6).toUpperCase()}`)
      bgUserIds.set(`BGUSER-${raw.slice(6).toUpperCase()}`.toLowerCase(), id)
    }
  }
  
  console.log(`Searching for ${nullTraderIds.length} traders`)
  console.log('Sample raw IDs:', [...rawIds].slice(0, 5))
  console.log('BGUser mappings:', [...bgUserIds.entries()].slice(0, 3))

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

  // Try search API
  console.log('=== Testing search API ===')
  const searchTests = [
    { searchContent: '10comjak', dataCycle: 7 },
    { searchContent: 'al1as', dataCycle: 7 },
    { searchContent: 'BGUSER-1PSVKJRP', dataCycle: 7 },
  ]
  for (const params of searchTests) {
    const r = await page.evaluate(async (params) => {
      try {
        const resp = await fetch('/v1/trace/spot/public/uta/traderView', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageNo: 1, pageSize: 10, sortRule: 2, sortFlag: 0, ...params, fullStatus: 1, languageType: 0 })
        })
        return { status: resp.status, data: await resp.json() }
      } catch(e) { return { error: e.toString() } }
    }, params)
    
    const rows = r.data?.data?.rows || []
    console.log(`Search "${params.searchContent}": ${rows.length} results`)
    if (rows.length) {
      console.log('  First result:', JSON.stringify({ userName: rows[0].userName, displayName: rows[0].displayName, traderUid: rows[0].traderUid }))
    }
    await sleep(500)
  }

  // Scan through ALL pages of 7d leaderboard
  console.log('\n=== Scanning ALL 7d leaderboard pages ===')
  const found7d = {}
  let totalScanned = 0

  for (let page_no = 1; page_no <= 200; page_no++) {
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
    const nextFlag = r.data?.data?.nextFlag
    if (!rows?.length) {
      console.log(`\nPage ${page_no}: no rows (end of results)`)
      break
    }

    totalScanned += rows.length

    for (const row of rows) {
      const uid = row.traderUid
      const userName = (row.userName || '').toLowerCase()
      const displayName = (row.displayName || '').toLowerCase()
      
      // Check if userName matches any of our raw IDs (without spot_ prefix)
      if (rawIds.has(userName) || rawIds.has(displayName)) {
        const matchKey = rawIds.has(userName) ? `spot_${userName}` : `spot_${displayName}`
        const roi = row.itemVoList?.find(i => i.showColumnCode === 'profit_rate')?.comparedValue
        found7d[matchKey] = { uid, userName: row.userName, displayName: row.displayName, roi7d: roi }
        console.log(`\n  ✅ MATCH! ${matchKey} -> uid=${uid} userName=${row.userName} roi7d=${roi}`)
      }
      
      // Check bguser format
      for (const [bgKey, bgVal] of bgUserIds) {
        if (userName === bgKey || displayName === bgKey) {
          const originalId = nullTraderIds.find(id => {
            const raw = id.replace(/^spot_/, '').toLowerCase()
            return raw === bgKey || `bguser-${raw.slice(6)}` === bgKey
          })
          if (originalId) {
            const roi = row.itemVoList?.find(i => i.showColumnCode === 'profit_rate')?.comparedValue
            found7d[originalId] = { uid, userName: row.userName, displayName: row.displayName, roi7d: roi }
            console.log(`\n  ✅ BGUSER MATCH! ${originalId} -> uid=${uid} roi7d=${roi}`)
          }
        }
      }
    }

    if (!nextFlag) {
      console.log(`\nPage ${page_no}: nextFlag=false, done.`)
      break
    }

    if (page_no % 20 === 0) {
      console.log(`\nScanned ${totalScanned} traders, found ${Object.keys(found7d).length} so far...`)
    }
    await sleep(200)
  }

  console.log(`\n=== Results ===`)
  console.log(`Total scanned: ${totalScanned}`)
  console.log(`Found: ${Object.keys(found7d).length}`)
  console.log(JSON.stringify(found7d, null, 2))

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
