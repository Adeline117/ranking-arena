#!/usr/bin/env node
/**
 * Fix MEXC NULL avatar_url traders
 * 
 * Strategy:
 * 1. Paginate v1/traders/v2 API (multiple sort orders) → build nickname+uid → avatar map
 * 2. For numeric-UID traders: match by uid
 * 3. For handle-based traders: match by nickname (case-insensitive)
 * 4. Update avatar_url where matched
 * 
 * HARD RULES:
 * - Only update source='mexc' rows
 * - Only where avatar confirmed from real API
 * - No fabrication
 */

import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const HEX_PATTERN = /^[a-f0-9]{32}$/
const CACHE_FILE = '/tmp/mexc_avatar_map.json'

const supabase = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

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
  console.log('🌐 Loading MEXC...')
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(4000)
  return { browser, page }
}

async function buildAvatarMap(page, targetNicknames, targetUids) {
  // Build avatar map: uid → {nickname, avatar}, nickLower → avatar
  const byUid = new Map()
  const byNick = new Map() // lowercase → avatar
  
  const orderBys = ['COMPREHENSIVE', 'FOLLOWERS', 'ROI', 'PNL']
  
  for (const orderBy of orderBys) {
    const prevByNick = byNick.size
    const prevByUid = byUid.size
    let pageNum = 1
    let staleCount = 0
    
    console.log(`\n  📡 ${orderBy}...`)
    
    while (pageNum <= 800) {
      let items
      try {
        items = await page.evaluate(async (pg, ob) => {
          const r = await fetch(
            `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=30&orderBy=${ob}&page=${pg}`
          )
          const d = await r.json()
          return d?.data?.content || null
        }, pageNum, orderBy)
      } catch {
        items = null
      }
      
      if (items === null) break
      if (!Array.isArray(items) || items.length === 0) break
      
      const prevNick = byNick.size
      for (const t of items) {
        const uid = String(t.uid || '').trim()
        const nickname = (t.nickname || t.nickName || '').trim()
        const avatar = t.avatar || null
        if (!avatar) continue
        
        if (uid) byUid.set(uid, { nickname, avatar })
        if (nickname) {
          byNick.set(nickname.toLowerCase(), avatar)
          byNick.set(nickname, avatar) // exact case too
        }
      }
      
      if (byNick.size === prevNick) staleCount++
      else staleCount = 0
      
      if (staleCount >= 5) break
      if (pageNum % 100 === 0) {
        console.log(`    p${pageNum}: byUid=${byUid.size} byNick=${byNick.size/2}`)
      }
      
      // Check coverage - stop early if we've found all targets
      const nickFound = [...targetNicknames].filter(n => byNick.has(n.toLowerCase())).length
      const uidFound = [...targetUids].filter(u => byUid.has(u)).length
      if (nickFound >= targetNicknames.size && uidFound >= targetUids.size) {
        console.log(`    ✓ All targets found at page ${pageNum}`)
        break
      }
      
      pageNum++
      if (pageNum > 1) await sleep(120)
    }
    
    const addedNick = (byNick.size - prevByNick) / 2
    const addedUid = byUid.size - prevByUid
    console.log(`    +${addedNick.toFixed(0)} nicknames, +${addedUid} uids`)
  }
  
  return { byUid, byNick }
}

async function main() {
  console.log('=== MEXC Avatar Fix ===')
  console.log('Time:', new Date().toISOString())
  
  // Get NULL-avatar MEXC traders
  let nullAvatarTraders = []
  let from = 0
  while (true) {
    const { data } = await supabase.from('trader_sources')
      .select('source_trader_id, handle, avatar_url')
      .eq('source', 'mexc')
      .is('avatar_url', null)
      .range(from, from + 999)
    if (!data || data.length === 0) break
    nullAvatarTraders = nullAvatarTraders.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  
  // Categorize (skip hex handles)
  const numericPattern = /^\d+$/
  const toFixByUid = nullAvatarTraders.filter(r => !HEX_PATTERN.test(r.handle) && numericPattern.test(r.source_trader_id))
  const toFixByNick = nullAvatarTraders.filter(r => !HEX_PATTERN.test(r.handle) && !numericPattern.test(r.source_trader_id))
  const hexSkipped = nullAvatarTraders.filter(r => HEX_PATTERN.test(r.handle))
  
  console.log('\nBEFORE:')
  console.log('  Total NULL avatar:', nullAvatarTraders.length)
  console.log('  To fix by UID:', toFixByUid.length)
  console.log('  To fix by nickname:', toFixByNick.length)
  console.log('  Hex handles (skip):', hexSkipped.length)
  
  if (toFixByUid.length === 0 && toFixByNick.length === 0) {
    console.log('Nothing to fix!')
    return
  }
  
  // Build target sets for early stopping
  const targetUids = new Set(toFixByUid.map(r => r.source_trader_id))
  const targetNicknames = new Set(toFixByNick.map(r => r.handle))
  
  // Check cache
  let byUid, byNick
  if (fs.existsSync(CACHE_FILE)) {
    console.log('\n📦 Loading from cache...')
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    byUid = new Map(Object.entries(cache.byUid || {}))
    byNick = new Map(Object.entries(cache.byNick || {}))
    console.log(`  byUid: ${byUid.size}, byNick: ${byNick.size}`)
  } else {
    // Launch browser and fetch API
    let browser, page
    ;({ browser, page } = await launchBrowser())
    
    try {
      ;({ byUid, byNick } = await buildAvatarMap(page, targetNicknames, targetUids))
    } finally {
      await browser.close().catch(() => {})
    }
    
    // Cache results
    const cacheObj = {
      byUid: Object.fromEntries(byUid),
      byNick: Object.fromEntries(byNick),
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheObj))
    console.log(`\n💾 Cached: ${byUid.size} uids, ${byNick.size} nick entries`)
  }
  
  console.log(`\n📡 API map: ${byUid.size} UIDs, ${byNick.size/2} nicknames`)
  
  // Apply fixes
  let fixedByUid = 0, fixedByNick = 0
  let uidNotFound = 0, nickNotFound = 0
  
  // Fix by UID
  console.log('\n🔧 Fixing by UID...')
  for (const row of toFixByUid) {
    const entry = byUid.get(row.source_trader_id)
    if (!entry || !entry.avatar) { uidNotFound++; continue }
    
    const { error } = await supabase.from('trader_sources')
      .update({ avatar_url: entry.avatar })
      .eq('source', 'mexc')
      .eq('source_trader_id', row.source_trader_id)
    
    if (!error) {
      fixedByUid++
      console.log(`  ✓ ${row.handle} (uid ${row.source_trader_id}) → ${entry.avatar.split('/').pop()}`)
    } else {
      console.log(`  ⚠ ${row.source_trader_id}: ${error.message}`)
    }
  }
  console.log(`  Fixed: ${fixedByUid} | Not found in API: ${uidNotFound}`)
  
  // Fix by nickname
  console.log('\n🔧 Fixing by nickname...')
  let notFoundList = []
  for (const row of toFixByNick) {
    const avatar = byNick.get(row.handle) || byNick.get(row.handle.toLowerCase())
    if (!avatar) { 
      nickNotFound++
      notFoundList.push(row.handle)
      continue 
    }
    
    const { error } = await supabase.from('trader_sources')
      .update({ avatar_url: avatar })
      .eq('source', 'mexc')
      .eq('source_trader_id', row.source_trader_id)
    
    if (!error) {
      fixedByNick++
    } else {
      console.log(`  ⚠ ${row.handle}: ${error.message}`)
    }
    
    if ((fixedByNick + nickNotFound) % 50 === 0) {
      process.stdout.write(`\r  Progress: ${fixedByNick} fixed, ${nickNotFound} not found...`)
    }
  }
  console.log(`\n  Fixed: ${fixedByNick} | Not found in API: ${nickNotFound}`)
  if (notFoundList.length > 0) {
    console.log(`  Sample not found: ${notFoundList.slice(0, 10).join(', ')}`)
  }
  
  // Final count
  const { count: finalNull } = await supabase.from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'mexc')
    .is('avatar_url', null)
  
  const totalFixed = fixedByUid + fixedByNick
  
  console.log('\n✅ SUMMARY:')
  console.log(`  Avatars filled: ${totalFixed} (${fixedByUid} by uid, ${fixedByNick} by nickname)`)
  console.log(`  Not found in API: ${uidNotFound + nickNotFound}`)
  console.log(`  NULL avatars remaining: ${finalNull}`)
  console.log(`  Hex-handle traders: cannot resolve (deprecated MEXC ID system)`)
}

main().catch(e => { console.error(e); process.exit(1) })
