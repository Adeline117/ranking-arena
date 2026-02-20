#!/usr/bin/env node
/**
 * fix-avatars-bitget.mjs
 * Fetch and store real avatar URLs for bitget_futures traders.
 * 
 * Uses Playwright to access the internal Bitget API:
 *   POST /v1/trigger/trace/public/traderViewV3
 *   Returns: { data: { rows: [{ traderUid, headPic, nickName }] } }
 * 
 * source_trader_id in DB = traderUid (hex string)
 * 
 * HARD RULES:
 *   - Only update WHERE avatar_url IS NULL in trader_sources
 *   - Never overwrite existing avatars
 *   - Only real CDN URLs, no fabricated avatars
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

function isRealAvatar(url) {
  if (!url || typeof url !== 'string' || url.length < 10) return false
  if (!url.startsWith('http')) return false
  const lower = url.toLowerCase()
  const fakes = ['placeholder', 'boringavatars', 'dicebear', 'identicon', 'favicon']
  return !fakes.some(f => lower.includes(f))
}

function extractTraders(data, avatarMap) {
  if (!data) return
  // traderViewV3: data.rows[].traderUid, headPic
  const rows = data.rows || data.list || data.traderList || []
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const uid = row.traderUid || row.traderId || row.uid
    const pic = row.headPic || row.headUrl || row.avatar || row.portraitLink
    if (uid && isRealAvatar(pic)) avatarMap.set(String(uid), pic)
  }
  // Sometimes nested
  if (Array.isArray(data)) {
    for (const row of data) {
      const uid = row.traderUid || row.traderId || row.uid
      const pic = row.headPic || row.headUrl || row.avatar
      if (uid && isRealAvatar(pic)) avatarMap.set(String(uid), pic)
    }
  }
}

async function main() {
  console.log('🖼️  Bitget Futures Avatar Fix\n')

  // Fetch traders with null avatar
  let allRows = []
  let start = 0
  while (true) {
    const { data, error } = await sb
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', 'bitget_futures')
      .is('avatar_url', null)
      .range(start, start + 499)
    if (error) throw new Error('DB error: ' + error.message)
    if (!data || data.length === 0) break
    allRows = allRows.concat(data)
    if (data.length < 500) break
    start += 500
  }

  console.log(`📊 Before: ${allRows.length} traders need avatars`)
  if (allRows.length === 0) { console.log('✅ Nothing to do!'); return }

  const missingIds = new Set(allRows.map(r => r.source_trader_id))
  const avatarMap = new Map() // traderUid -> headPic

  console.log('\n🎭 Launching Playwright...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  // Intercept API responses from leaderboard page
  page.on('response', async (resp) => {
    if (resp.status() !== 200) return
    const url = resp.url()
    try {
      if (url.includes('traderView') || url.includes('traderList') || url.includes('topTrader') || url.includes('followFeed')) {
        const json = await resp.json().catch(() => null)
        if (json?.data) extractTraders(json.data, avatarMap)
      }
    } catch {}
  })

  // Navigate to leaderboard
  console.log('  Loading Bitget copy trading page...')
  try {
    await page.goto('https://www.bitget.com/copy-trading/futures', {
      waitUntil: 'networkidle',
      timeout: 35000,
    })
    await sleep(3000)
  } catch (e) {
    console.log('  Load error (non-fatal):', e.message.slice(0, 80))
  }
  console.log(`  After page load: ${avatarMap.size} avatars`)

  // Use page.evaluate to call traderViewV3 API directly from browser context
  console.log('  Paginating traderViewV3 API...')
  
  const sortKeys = ['yieldRate', 'followCount', 'totalProfit', 'maxDrawDown']
  const periodTypes = ['NINETY_DAYS', 'THIRTY_DAYS', 'SEVEN_DAYS']
  
  for (const periodType of periodTypes) {
    for (const sortKey of sortKeys) {
      let pageNo = 1
      let hasMore = true
      
      while (hasMore && pageNo <= 50) {
        try {
          const result = await page.evaluate(async ({ pageNo, sortKey, periodType }) => {
            try {
              const resp = await fetch('/v1/trigger/trace/public/traderViewV3', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  pageNo,
                  pageSize: 50,
                  sortKey,
                  sortType: 'DESC',
                  traceType: 'CONTRACT',
                  periodType,
                })
              })
              const json = await resp.json()
              return json
            } catch (e) {
              return { error: e.message }
            }
          }, { pageNo, sortKey, periodType })
          
          if (result?.error) { hasMore = false; break }
          
          const traders = result?.data?.rows || result?.data?.list || []
          if (traders.length > 0) {
            for (const t of traders) {
              const uid = t.traderUid || t.traderId
              const pic = t.headPic || t.headUrl || t.avatar
              if (uid && isRealAvatar(pic)) avatarMap.set(String(uid), pic)
            }
            process.stdout.write(`  ${periodType}/${sortKey} p${pageNo}: +${traders.length} (total ${avatarMap.size})\r`)
            if (traders.length < 50 || !result?.data?.nextFlag) {
              hasMore = false
            } else {
              pageNo++
            }
          } else {
            hasMore = false
          }
          await sleep(400)
        } catch (e) {
          console.log(`  Error on ${periodType}/${sortKey} p${pageNo}: ${e.message.slice(0, 60)}`)
          hasMore = false
        }
      }
      
      // Check if we have enough
      const foundCount = allRows.filter(r => avatarMap.has(r.source_trader_id)).length
      console.log(`\n  ${periodType}/${sortKey}: ${avatarMap.size} total, ${foundCount}/${allRows.length} matched`)
      
      if (foundCount >= allRows.length) break
      await sleep(500)
    }
    
    const foundCount = allRows.filter(r => avatarMap.has(r.source_trader_id)).length
    if (foundCount >= allRows.length) break
  }

  console.log(`\n  Total avatars collected: ${avatarMap.size}`)
  const stillMissing = allRows.filter(r => !avatarMap.has(r.source_trader_id))
  
  // For remaining missing traders, try individual profile pages
  if (stillMissing.length > 0 && stillMissing.length <= 200) {
    console.log(`\n  Trying ${stillMissing.length} individual trader pages...`)
    
    for (let i = 0; i < stillMissing.length; i++) {
      const trader = stillMissing[i]
      let foundAvatar = null
      
      const handler = async (resp) => {
        if (resp.status() !== 200) return
        const url = resp.url()
        try {
          if (url.includes('traderDetail') || url.includes('traderViewV3') || url.includes('currentTrader')) {
            const json = await resp.json().catch(() => null)
            if (!json) return
            const d = json?.data
            const avatar = d?.headPic || d?.headUrl || d?.avatar || d?.traderInfo?.headPic
            if (isRealAvatar(avatar)) foundAvatar = avatar
          }
        } catch {}
      }
      page.on('response', handler)
      
      try {
        await page.goto(
          `https://www.bitget.com/copy-trading/trader/${trader.source_trader_id}/futures`,
          { waitUntil: 'domcontentloaded', timeout: 15000 }
        )
        await sleep(2500)
      } catch {}
      
      page.off('response', handler)
      
      if (foundAvatar) {
        avatarMap.set(trader.source_trader_id, foundAvatar)
      }
      
      if ((i + 1) % 20 === 0) {
        console.log(`  Individual pages: ${i+1}/${stillMissing.length} (${avatarMap.size} total avatars)`)
      }
      await sleep(1000 + Math.random() * 500)
    }
  }

  await browser.close()

  // Update DB
  console.log('\n💾 Updating trader_sources...')
  let updated = 0, skipped = 0

  for (const row of allRows) {
    const avatar = avatarMap.get(row.source_trader_id)
    if (!avatar) { skipped++; continue }

    const { error } = await sb
      .from('trader_sources')
      .update({ avatar_url: avatar })
      .eq('id', row.id)
      .is('avatar_url', null) // safety

    if (error) {
      console.warn(`  ❌ id=${row.id}: ${error.message}`)
    } else {
      updated++
    }
  }

  const { count: nullCount } = await sb
    .from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bitget_futures')
    .is('avatar_url', null)

  console.log(`\n✅ Updated: ${updated} | Skipped: ${skipped}`)
  console.log(`📊 After: bitget_futures null_avatar=${nullCount}`)
}

main().catch(e => { console.error(e); process.exit(1) })
