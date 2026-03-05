#!/usr/bin/env node
/**
 * Scrape Bitget trader avatars via Playwright
 * Navigates to leaderboard page, intercepts API, then visits "all traders" view
 * and paginates to collect headPic URLs for all traders.
 * 
 * Usage: node scripts/bitget-avatar-scrape.mjs [--dry-run] [--limit=500]
 */

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '500')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function isRealAvatar(url) {
  if (!url || url.length < 10 || !url.startsWith('http')) return false
  // Accept default avatars from exchanges - they're still real URLs
  // Only filter out truly fake/generated ones
  const lower = url.toLowerCase()
  return !['placeholder', 'favicon', 'boringavatars', 'dicebear', 'identicon'].some(f => lower.includes(f))
}

async function main() {
  // 1. Get missing traders
  const { data: missing, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle')
    .eq('source', 'bitget_futures')
    .is('avatar_url', null)
    .limit(LIMIT)
  
  if (error) { console.error('DB error:', error.message); process.exit(1) }
  if (!missing?.length) { console.log('No missing avatars!'); process.exit(0) }
  
  console.log(`${missing.length} bitget_futures traders need avatars`)
  const missingIds = new Set(missing.map(t => t.source_trader_id))
  const avatarMap = new Map() // traderUid -> headPic

  // 2. Launch browser
  const browser = await chromium.launch({ 
    headless: false,
    args: ['--proxy-server=http://127.0.0.1:7890']
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()

  // Intercept all responses for trader data
  page.on('response', async (resp) => {
    if (resp.status() !== 200) return
    const url = resp.url()
    try {
      if (url.includes('topTraders') || url.includes('traderView') || url.includes('traderList') || 
          url.includes('followFeed') || url.includes('traderRanking') || url.includes('allTrader')) {
        const json = await resp.json()
        extractTraders(json?.data)
      }
    } catch {}
  })

  function extractTraders(data) {
    if (!data) return
    // topTraders: data.rows[].showColumnValue[]
    if (data.rows && Array.isArray(data.rows)) {
      for (const row of data.rows) {
        const traders = row.showColumnValue || []
        for (const t of traders) {
          if (t.traderUid && t.headPic) avatarMap.set(t.traderUid, t.headPic)
        }
      }
    }
    // traderList/followFeed: array of traders
    if (Array.isArray(data)) {
      for (const t of data) {
        const uid = t.traderUid || t.traderUserId || t.traderId
        const pic = t.headPic || t.headUrl || t.avatar
        if (uid && pic) avatarMap.set(uid, pic)
      }
    }
    // Generic list
    if (data.list || data.traderList) {
      const list = data.list || data.traderList
      if (Array.isArray(list)) {
        for (const t of list) {
          const uid = t.traderUid || t.traderUserId || t.traderId
          const pic = t.headPic || t.headUrl || t.avatar
          if (uid && pic) avatarMap.set(uid, pic)
        }
      }
    }
  }

  // 3. Visit leaderboard
  console.log('Visiting Bitget leaderboard...')
  await page.goto('https://www.bitget.com/copy-trading/futures', { waitUntil: 'networkidle', timeout: 60000 })
  await sleep(3000)
  console.log(`After leaderboard: ${avatarMap.size} avatars`)

  // 4. Try to navigate to "all traders" tab
  // Scroll and look for more content
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 800))
    await sleep(500)
  }
  await sleep(2000)
  console.log(`After scroll: ${avatarMap.size} avatars`)

  // 5. Try the traderViewV3 API directly from the browser context (bypasses Cloudflare)
  console.log('Trying traderViewV3 API from browser context...')
  for (let pageNo = 1; pageNo <= 60; pageNo++) {
    try {
      const result = await page.evaluate(async (pn) => {
        const resp = await fetch(`/v1/trigger/trace/public/traderViewV3`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pageNo: pn,
            pageSize: 50,
            sortKey: 'yieldRate',
            sortType: 'DESC',
            traceType: 'CONTRACT',
            periodType: 'NINETY_DAYS',
          })
        })
        return await resp.json()
      }, pageNo)
      
      // Response has rows[] array with trader objects (NOT list[])
      const traders = result?.data?.rows || result?.data?.list || []
      if (traders.length > 0) {
        for (const t of traders) {
          const uid = t.traderUid || t.traderId
          const pic = t.headPic || t.headUrl
          if (uid && pic) avatarMap.set(uid, pic)
        }
        console.log(`  Page ${pageNo}: +${traders.length} traders, total avatars: ${avatarMap.size}`)
        if (traders.length < 50 || !result?.data?.nextFlag) break
      } else {
        console.log(`  Page ${pageNo}: no data`, result?.code, result?.msg)
        break
      }
      await sleep(500)
    } catch (err) {
      console.error(`  Page ${pageNo} error:`, err.message)
      break
    }
  }

  console.log(`\nTotal avatars collected: ${avatarMap.size}`)

  // 6. Match and update
  let updated = 0, skipped = 0
  for (const trader of missing) {
    const avatar = avatarMap.get(trader.source_trader_id)
    if (!avatar) { skipped++; continue }
    if (!isRealAvatar(avatar)) { skipped++; continue }
    
    if (DRY_RUN) {
      console.log(`[DRY-RUN] ${trader.handle}: ${avatar}`)
      updated++
    } else {
      const { error } = await supabase
        .from('leaderboard_ranks')
        .update({ avatar_url: avatar })
        .eq('id', trader.id)
      if (!error) {
        updated++
        if (updated % 50 === 0) console.log(`  Updated ${updated}...`)
      }
    }
  }

  console.log(`\n✅ Updated: ${updated}, Skipped: ${skipped}, No match: ${missing.length - updated - skipped}`)
  await browser.close()
}

main().catch(err => { console.error(err); process.exit(1) })
