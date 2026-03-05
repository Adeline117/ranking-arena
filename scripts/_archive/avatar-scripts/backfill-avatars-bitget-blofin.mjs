#!/usr/bin/env node
/**
 * Backfill avatar_url for bitget_futures and blofin traders
 * Uses Playwright to bypass Cloudflare and intercept API responses
 * 
 * Usage: node scripts/backfill-avatars-bitget-blofin.mjs [--source=bitget_futures|blofin] [--limit=500] [--dry-run]
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
const SOURCE = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'all'
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '500')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function isRealAvatar(url) {
  if (!url || url.length < 10 || !url.startsWith('http')) return false
  const lower = url.toLowerCase()
  const fakes = ['default', 'placeholder', 'favicon.ico', 'boringavatars', 'dicebear', 'identicon']
  return !fakes.some(f => lower.includes(f))
}

async function getMissing(source, limit) {
  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle')
    .eq('source', source)
    .is('avatar_url', null)
    .limit(limit)
  if (error) throw error
  return data || []
}

async function updateAvatar(id, url) {
  if (DRY_RUN) { console.log(`  [DRY-RUN] Would set id=${id} avatar=${url}`); return true }
  const { error } = await supabase
    .from('leaderboard_ranks')
    .update({ avatar_url: url })
    .eq('id', id)
  if (error) { console.warn(`  Failed to update id=${id}: ${error.message}`); return false }
  return true
}

// ══════════════════════════════════════════════════════════
// BITGET FUTURES — Visit leaderboard page, intercept traderList API
// ══════════════════════════════════════════════════════════

async function backfillBitgetBulk(browser) {
  console.log('\n═══ BITGET FUTURES (Bulk from leaderboard) ═══')
  const missing = await getMissing('bitget_futures', LIMIT)
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))
  const avatarMap = new Map() // traderId -> avatarUrl

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  // Intercept API responses from the leaderboard page
  page.on('response', async (resp) => {
    if (resp.status() !== 200) return
    const url = resp.url()
    try {
      if (url.includes('traderViewV3') || url.includes('traderList') || url.includes('query-traders') || url.includes('ranking')) {
        const json = await resp.json()
        const list = json?.data?.traderList || json?.data?.list || json?.data || []
        if (!Array.isArray(list)) return
        for (const t of list) {
          const id = t.traderId || t.traderUid || t.uid
          const avatar = t.headUrl || t.avatar || t.portraitLink
          if (id && avatar && isRealAvatar(avatar)) {
            avatarMap.set(String(id), avatar)
          }
        }
        console.log(`  Intercepted ${list.length} traders, ${avatarMap.size} total avatars found`)
      }
    } catch {}
  })

  // Visit leaderboard pages
  try {
    console.log('  Visiting Bitget copy-trading leaderboard...')
    await page.goto('https://www.bitget.com/copy-trading/futures', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)

    // Scroll down to load more traders
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.scrollBy(0, 800))
      await sleep(1000)
      // Check if "load more" or pagination exists
      const loadMore = await page.$('button:has-text("Load More"), .pagination .next, [class*="loadMore"]')
      if (loadMore) {
        try { await loadMore.click(); await sleep(2000) } catch {}
      }
    }
  } catch (err) {
    console.warn(`  Page load error: ${err.message}`)
  }

  // Now try individual trader pages for those still missing
  let updated = 0
  for (const [traderId, trader] of missingMap) {
    if (avatarMap.has(traderId)) {
      const url = avatarMap.get(traderId)
      if (await updateAvatar(trader.id, url)) {
        updated++
        console.log(`  ✅ ${trader.handle}: ${url}`)
      }
    }
  }

  // For remaining missing, try individual profile pages (batch of 20)
  const stillMissing = missing.filter(t => !avatarMap.has(t.source_trader_id))
  if (stillMissing.length > 0) {
    console.log(`\n  Trying individual profile pages for ${stillMissing.length} remaining...`)
    const batchSize = Math.min(stillMissing.length, 50)
    
    for (let i = 0; i < batchSize; i++) {
      const trader = stillMissing[i]
      try {
        let foundAvatar = null
        const handler = async (resp) => {
          if (resp.status() !== 200) return
          const url = resp.url()
          try {
            if (url.includes('traderDetailPageV2') || url.includes('traderDetail') || url.includes('currentTrader')) {
              const json = await resp.json()
              const d = json?.data
              const avatar = d?.headUrl || d?.avatar || d?.portraitLink || d?.traderInfo?.headUrl
              if (avatar && isRealAvatar(avatar)) foundAvatar = avatar
            }
          } catch {}
        }
        page.on('response', handler)
        
        await page.goto(
          `https://www.bitget.com/copy-trading/trader/${trader.source_trader_id}/futures`,
          { waitUntil: 'domcontentloaded', timeout: 15000 }
        )
        await sleep(3000)
        page.removeListener('response', handler)

        if (foundAvatar) {
          if (await updateAvatar(trader.id, foundAvatar)) {
            updated++
            console.log(`  ✅ [${i+1}/${batchSize}] ${trader.handle}: ${foundAvatar}`)
          }
        } else {
          console.log(`  ⏭️  [${i+1}/${batchSize}] ${trader.handle}: no avatar found`)
        }
        
        await sleep(1500 + Math.random() * 1000) // Rate limit
      } catch (err) {
        console.warn(`  ❌ [${i+1}/${batchSize}] ${trader.handle}: ${err.message}`)
      }
    }
  }

  await context.close()
  console.log(`  Total updated: ${updated}/${missing.length}`)
  return updated
}

// ══════════════════════════════════════════════════════════
// BLOFIN — Visit copy-trade page, intercept trader list API
// ══════════════════════════════════════════════════════════

async function backfillBlofin(browser) {
  console.log('\n═══ BLOFIN ═══')
  const missing = await getMissing('blofin', LIMIT)
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  // Build lookup by handle (source_trader_id is "blofin_<handle>")
  const missingMap = new Map()
  for (const t of missing) {
    missingMap.set(t.source_trader_id, t)
    // Also map by handle variants
    missingMap.set(t.handle?.toLowerCase(), t)
  }

  const avatarMap = new Map() // source_trader_id -> avatar_url

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  page.on('response', async (resp) => {
    if (resp.status() !== 200) return
    const url = resp.url()
    try {
      if (url.includes('copy') || url.includes('trader') || url.includes('rank') || url.includes('lead')) {
        const json = await resp.json()
        const list = json?.data?.traderList || json?.data?.list || json?.data?.rows || json?.data || []
        if (!Array.isArray(list)) return
        for (const t of list) {
          const id = t.traderId || t.uniqueName || t.traderUid
          const nickname = t.nickName || t.traderName || ''
          const avatar = t.avatar || t.avatarUrl || t.portraitLink
          if (!avatar || !isRealAvatar(avatar)) continue

          // Match by source_trader_id or handle
          const sourceId = `blofin_${(nickname || id || '').toLowerCase().replace(/\s+/g, '')}`
          if (missingMap.has(sourceId)) {
            avatarMap.set(sourceId, avatar)
          }
          if (missingMap.has(nickname?.toLowerCase())) {
            const trader = missingMap.get(nickname.toLowerCase())
            avatarMap.set(trader.source_trader_id, avatar)
          }
          // Also try with traderId
          if (id) {
            for (const [sid, trader] of missingMap) {
              if (sid.includes(String(id).toLowerCase())) {
                avatarMap.set(trader.source_trader_id, avatar)
              }
            }
          }
        }
        console.log(`  Intercepted traders from API, ${avatarMap.size} avatars matched`)
      }
    } catch {}
  })

  try {
    console.log('  Visiting BloFin copy-trade page...')
    await page.goto('https://blofin.com/en/copy-trade', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)

    // Scroll to load more
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(1000)
    }
  } catch (err) {
    console.warn(`  Page load error: ${err.message}`)
  }

  // Try individual trader pages for still-missing ones
  const matched = new Set(avatarMap.keys())
  const stillMissing = missing.filter(t => !matched.has(t.source_trader_id))
  
  if (stillMissing.length > 0) {
    console.log(`\n  ${stillMissing.length} still missing, trying individual pages...`)
    // BloFin trader pages: try with different ID formats
    // The ones with numeric IDs have avatars, the ones with "blofin_xxx" format don't
    // Check if there's a numeric ID in the DB for these traders
    for (const trader of stillMissing) {
      // The handle-based source_trader_id means we need to find via the page
      const handle = trader.handle
      try {
        let foundAvatar = null
        const handler = async (resp) => {
          if (resp.status() !== 200) return
          try {
            const json = await resp.json()
            const d = json?.data
            const avatar = d?.avatar || d?.avatarUrl || d?.portraitLink
            if (avatar && isRealAvatar(avatar)) foundAvatar = avatar
          } catch {}
        }
        page.on('response', handler)
        
        // Try searching for the trader
        const searchUrl = `https://blofin.com/en/copy-trade?search=${encodeURIComponent(handle)}`
        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 15000 })
        await sleep(2000)
        page.removeListener('response', handler)

        if (foundAvatar) {
          avatarMap.set(trader.source_trader_id, foundAvatar)
        }
        await sleep(1000)
      } catch (err) {
        console.warn(`  Error for ${handle}: ${err.message}`)
      }
    }
  }

  let updated = 0
  for (const [sourceId, avatarUrl] of avatarMap) {
    const trader = missing.find(t => t.source_trader_id === sourceId)
    if (trader && await updateAvatar(trader.id, avatarUrl)) {
      updated++
      console.log(`  ✅ ${trader.handle}: ${avatarUrl}`)
    }
  }

  await context.close()
  console.log(`  Total updated: ${updated}/${missing.length}`)
  return updated
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════

async function main() {
  console.log(`Avatar backfill — source=${SOURCE}, limit=${LIMIT}, dry-run=${DRY_RUN}`)
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--proxy-server=http://127.0.0.1:7890']
  })

  let total = 0
  try {
    if (SOURCE === 'all' || SOURCE === 'bitget_futures') {
      total += await backfillBitgetBulk(browser)
    }
    if (SOURCE === 'all' || SOURCE === 'blofin') {
      total += await backfillBlofin(browser)
    }
  } finally {
    await browser.close()
  }

  console.log(`\n═══ DONE: ${total} avatars updated ═══`)
}

main().catch(err => { console.error(err); process.exit(1) })
