#!/usr/bin/env node
/**
 * Fix MEXC trader display names and avatars
 * 
 * Approach:
 * 1. Paginate ALL MEXC traders from the v1/traders/v2 API (22K+ traders)
 * 2. Build map: nickname → {uid, avatar}  AND  uid → {nickname, avatar}
 * 3. For NULL-avatar traders: match by nickname → fill avatar
 * 4. For hex-handle traders: check if any uid matches hex (unlikely but worth trying)
 * 5. Also try the contract API for individual hex ID lookup
 * 
 * HARD RULES:
 * - Only update where data confirmed from real API
 * - No guessing, no fabrication
 * - Only source='mexc' rows
 */

import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const CACHE_FILE = '/tmp/mexc_all_traders_v2.json'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const HEX_PATTERN = /^[a-f0-9]{32}$/

// ---------- STEP 1: Fetch all traders from MEXC API ----------

async function launchBrowser() {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  await page.setRequestInterception(true)
  page.on('request', req => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort()
    else req.continue()
  })
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(5000)
  return { browser, page }
}

async function fetchApiPage(page, pageNum, orderBy) {
  try {
    return await page.evaluate(async (pg, ob) => {
      const resp = await fetch(
        `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=30&orderBy=${ob}&page=${pg}`
      )
      const data = await resp.json()
      return data?.data?.content || null
    }, pageNum, orderBy)
  } catch {
    return null
  }
}

async function fetchAllMexcTraders() {
  // Check cache
  if (fs.existsSync(CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    console.log(`📦 Using cache: ${Object.keys(cached).length} traders`)
    return new Map(Object.entries(cached))
  }

  console.log('🌐 Launching browser to fetch ALL MEXC traders...')
  let { browser, page } = await launchBrowser()
  
  // Map: uid → {nickname, avatar}
  const traders = new Map()
  
  // Try multiple sort orders to maximize coverage
  const orderBys = ['COMPREHENSIVE', 'FOLLOWERS', 'ROI', 'PNL']
  
  for (const orderBy of orderBys) {
    let pageNum = 1
    let staleCount = 0
    const prevSize = traders.size
    console.log(`\n📡 Fetching by ${orderBy}...`)
    
    while (pageNum <= 800) { // 800 pages * 30 = 24000 traders per order
      let items = await fetchApiPage(page, pageNum, orderBy)
      
      if (items === null) {
        // Browser might have crashed
        console.log(`  ⚠ Browser issue at page ${pageNum}, relaunching...`)
        await browser.close().catch(() => {})
        ;({ browser, page } = await launchBrowser())
        items = await fetchApiPage(page, pageNum, orderBy)
        if (items === null) {
          console.log('  ❌ Failed after relaunch, stopping this order')
          break
        }
      }
      
      if (!Array.isArray(items) || items.length === 0) break
      
      const prevCount = traders.size
      for (const t of items) {
        const uid = String(t.uid || '').trim()
        const nickname = (t.nickname || t.nickName || '').trim()
        const avatar = t.avatar || null
        
        if (!uid && !nickname) continue
        if (traders.has(uid)) continue // already have this trader
        
        traders.set(uid, { uid, nickname, avatar })
      }
      
      const added = traders.size - prevCount
      if (added === 0) {
        staleCount++
        if (staleCount >= 5) {
          console.log(`  Stale for 5 pages, stopping`)
          break
        }
      } else {
        staleCount = 0
      }
      
      if (pageNum % 50 === 0) console.log(`  ${orderBy} p${pageNum}: ${traders.size} unique traders`)
      pageNum++
      if (pageNum > 1) await sleep(150)
    }
    
    console.log(`  ${orderBy}: added ${traders.size - prevSize} new traders (total: ${traders.size})`)
  }
  
  await browser.close().catch(() => {})
  
  // Also build by-nickname index and also add avatar interception
  console.log(`\n📊 Total unique traders fetched: ${traders.size}`)
  
  // Cache it
  const cacheObj = {}
  for (const [k, v] of traders) cacheObj[k] = v
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheObj))
  console.log(`💾 Cached to ${CACHE_FILE}`)
  
  return traders
}

// ---------- STEP 2: Get DB records to fix ----------

async function getDbRecords() {
  let allMexc = []
  let from = 0
  while (true) {
    const { data, error } = await supabase.from('trader_sources')
      .select('source_trader_id, handle, avatar_url')
      .eq('source', 'mexc')
      .range(from, from + 999)
    if (error || !data || data.length === 0) break
    allMexc = allMexc.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  return allMexc
}

// ---------- STEP 3: Apply fixes ----------

async function main() {
  console.log('=== MEXC Handle & Avatar Fix ===')
  console.log('Time:', new Date().toISOString())
  
  // Get current DB state
  console.log('\n📊 Fetching current DB state...')
  const allMexc = await getDbRecords()
  console.log('Total MEXC traders in DB:', allMexc.length)
  
  const hexHandles = allMexc.filter(r => HEX_PATTERN.test(r.handle))
  const nullAvatars = allMexc.filter(r => !r.avatar_url)
  const hexWithNullAvatar = nullAvatars.filter(r => HEX_PATTERN.test(r.handle))
  const nonHexNullAvatar = nullAvatars.filter(r => !HEX_PATTERN.test(r.handle))
  
  console.log('\nBEFORE:')
  console.log('  Hex-ID handles:', hexHandles.length)
  console.log('  NULL avatar_url:', nullAvatars.length)
  console.log('    └ hex handles with NULL avatar:', hexWithNullAvatar.length)
  console.log('    └ non-hex handles with NULL avatar:', nonHexNullAvatar.length)
  
  // Fetch all traders from MEXC API
  const apiTraders = await fetchAllMexcTraders()
  
  // Build lookup maps
  const byNickname = new Map() // lowercase nickname → trader
  const byUid = new Map()      // uid → trader
  
  for (const [uid, t] of apiTraders) {
    byUid.set(uid, t)
    if (t.nickname) {
      byNickname.set(t.nickname.toLowerCase(), t)
      byNickname.set(t.nickname, t) // also exact case
    }
  }
  
  console.log(`\n📡 API: ${apiTraders.size} traders loaded`)
  console.log(`  By nickname index: ${byNickname.size} entries`)
  
  // ---------- Fix 1: NULL avatar traders (non-hex handles) ----------
  console.log('\n🔧 Fixing NULL avatar traders (by nickname match)...')
  
  let avatarFixed = 0
  let avatarSkipped = 0
  const batchUpdates = []
  
  for (const row of nonHexNullAvatar) {
    const apiTrader = byNickname.get(row.handle) || byNickname.get(row.handle.toLowerCase())
    
    if (!apiTrader || !apiTrader.avatar) {
      avatarSkipped++
      continue
    }
    
    // Only update if avatar is a real, unique URL (not empty string)
    const avatar = apiTrader.avatar.trim()
    if (!avatar || avatar.length < 10) {
      avatarSkipped++
      continue
    }
    
    batchUpdates.push({
      source_trader_id: row.source_trader_id,
      avatar_url: avatar,
    })
  }
  
  console.log(`  Matched: ${batchUpdates.length} | Unmatched: ${avatarSkipped}`)
  
  // Apply avatar updates in batches
  if (batchUpdates.length > 0) {
    const BATCH = 50
    for (let i = 0; i < batchUpdates.length; i += BATCH) {
      const chunk = batchUpdates.slice(i, i + BATCH)
      for (const upd of chunk) {
        const { error } = await supabase.from('trader_sources')
          .update({ avatar_url: upd.avatar_url })
          .eq('source', 'mexc')
          .eq('source_trader_id', upd.source_trader_id)
        if (!error) avatarFixed++
        else console.log(`  ⚠ Update error for ${upd.source_trader_id}: ${error.message}`)
      }
      process.stdout.write(`\r  Updated: ${avatarFixed}/${batchUpdates.length}`)
      await sleep(100)
    }
    console.log(`\n  ✅ Avatar fixed: ${avatarFixed}`)
  }
  
  // ---------- Fix 2: Hex-handle traders ----------
  console.log('\n🔧 Attempting to fix hex-handle traders...')
  
  // Check if any hex IDs appear in the API (as uid)
  let hexFoundInApi = 0
  let hexHandleFixed = 0
  let hexAvatarFixed = 0
  const hexUpdates = []
  
  for (const row of hexHandles) {
    // Try: is the hex ID also a uid in the new API?
    const asUid = byUid.get(row.source_trader_id)
    if (asUid && asUid.nickname && !HEX_PATTERN.test(asUid.nickname)) {
      hexFoundInApi++
      hexUpdates.push({
        source_trader_id: row.source_trader_id,
        handle: asUid.nickname,
        avatar_url: asUid.avatar || null,
      })
    }
  }
  
  console.log(`  Hex IDs found in API (as uid): ${hexFoundInApi}`)
  
  // Also: check if any API trader's nickname matches a hex ID in our DB
  // (This would mean the API is returning hex IDs as nicknames)
  let hexNicknameMatch = 0
  for (const [uid, t] of apiTraders) {
    if (HEX_PATTERN.test(t.nickname)) {
      hexNicknameMatch++
    }
  }
  console.log(`  API traders with hex-like nicknames: ${hexNicknameMatch}`)
  
  // Apply hex handle fixes if any found
  if (hexUpdates.length > 0) {
    for (const upd of hexUpdates) {
      const updateData = {}
      if (upd.handle) updateData.handle = upd.handle
      if (upd.avatar_url) updateData.avatar_url = upd.avatar_url
      
      if (Object.keys(updateData).length === 0) continue
      
      const { error } = await supabase.from('trader_sources')
        .update(updateData)
        .eq('source', 'mexc')
        .eq('source_trader_id', upd.source_trader_id)
      
      if (!error) {
        if (upd.handle) hexHandleFixed++
        if (upd.avatar_url) hexAvatarFixed++
      }
    }
    console.log(`  ✅ Hex handle fixed: ${hexHandleFixed}`)
    console.log(`  ✅ Hex avatar fixed (from api): ${hexAvatarFixed}`)
  } else {
    console.log('  ℹ No hex IDs resolvable via current MEXC API (deprecated ID system)')
  }
  
  // ---------- Step 3: Also try to fill avatars for non-null handles ----------
  // Some non-hex traders might also benefit from avatar updates (check existing bad avatars)
  console.log('\n🔧 Also checking for banner-only avatars that could be improved...')
  const bannerOnly = allMexc.filter(r => 
    r.avatar_url && 
    r.avatar_url.includes('/banner/') && 
    !HEX_PATTERN.test(r.handle)
  )
  console.log(`  Non-hex traders with /banner/ avatars: ${bannerOnly.length}`)
  
  // NOTE: The /banner/ URLs ARE the actual MEXC avatar URLs (not ads)
  // The import script was wrong to filter them. They are valid avatars.
  // So we don't need to replace them - they are correct.
  console.log('  ℹ /banner/ URLs are actually valid MEXC avatar URLs (not filtered)')
  
  // ---------- Final verification ----------
  console.log('\n📊 Final verification...')
  const finalRecords = await getDbRecords()
  const finalHexHandles = finalRecords.filter(r => HEX_PATTERN.test(r.handle))
  const finalNullAvatars = finalRecords.filter(r => !r.avatar_url)
  
  console.log('\nAFTER:')
  console.log('  Hex-ID handles:', finalHexHandles.length, `(was ${hexHandles.length})`)
  console.log('  NULL avatar_url:', finalNullAvatars.length, `(was ${nullAvatars.length})`)
  
  console.log('\n✅ SUMMARY:')
  console.log(`  Handles fixed: ${hexHandleFixed}`)
  console.log(`  Avatars filled: ${avatarFixed}`)
  console.log(`  Hex traders unresolvable: ${hexHandles.length - hexHandleFixed} (from deprecated MEXC API)`)
  console.log(`  NULL avatars remaining: ${finalNullAvatars.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
