#!/usr/bin/env node
/**
 * Full scan: capture ALL traders from BingX leaderboard using v7 pagination approach
 * Extract UIDs from raw text to avoid JSON precision loss
 * Also capture spot traders
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Load target UIDs from DB
const { data: futRows } = await sb
  .from('leaderboard_ranks')
  .select('source_trader_id')
  .eq('source', 'bingx')
  .is('max_drawdown', null)

const targetUids = new Set(futRows?.map(r => r.source_trader_id) || [])
console.log(`Target futures UIDs: ${targetUids.size}`)

// UID extraction from raw text (avoids JSON precision loss)
function extractUidsFromText(text) {
  // Match "uid": NUMBER or "uid": "STRING"
  const matches = text.match(/"uid"\s*:\s*"?(\d{10,20})"?/g) || []
  return matches.map(m => m.match(/(\d{10,20})/)[1])
}

// Extract MDD and WR from raw text with precision-safe UID matching
function extractTradersFromRawText(text) {
  const traders = new Map() // uid -> { wr, mdd, nick }
  
  try {
    // First, find all item boundaries (look for "trader":{ patterns)
    // Parse normally but reconstruct uids from raw text
    
    // Get UIDs from raw text (precise)
    const uidMatches = [...text.matchAll(/"uid"\s*:\s*(\d{10,20})/g)]
    
    // Parse JSON for stats (precision doesn't matter for float stats)
    const json = JSON.parse(text)
    if (json.code !== 0) return traders
    
    const items = json?.data?.result || json?.data?.list || []
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const stat = item.rankStat || item.stat || {}
      const nick = item.trader?.nickName || item.trader?.nickname || ''
      
      // MDD extraction
      const mddCandidates = ['maxDrawDown', 'maxDrawdown', 'maxDrawDown90d', 'maxDrawdown90d',
        'maxDrawDown30d', 'maxDrawDown7d', 'maximumDrawDown']
      let mdd = null
      for (const k of mddCandidates) {
        if (stat[k] != null && stat[k] !== '') {
          mdd = stat[k]
          break
        }
      }
      
      // WR extraction
      const wrCandidates = ['winRate', 'winRate90d', 'winRate30d', 'winRate7d']
      let wr = null
      for (const k of wrCandidates) {
        if (stat[k] != null) { wr = stat[k]; break }
      }
      
      // Find the precise UID from raw text for this item
      // The raw text has uid values in order, matching item order
      // Each item has 2 uid refs: one as shortUid and one in trader object
      // We want the trader.uid specifically
      // Search for this specific item's uid in the raw text using item index
      const jsonUid = String(item.trader?.uid || item.uid || '')
      
      // Find corresponding precise UID from raw text
      // Find all uid values near the occurrence index in text
      const preciseUid = findPreciseUid(text, jsonUid, uidMatches)
      
      const uid = preciseUid || jsonUid
      if (uid && uid !== '0') {
        traders.set(uid, { wr, mdd, nick, jsonUid })
      }
    }
  } catch (e) {}
  
  return traders
}

function findPreciseUid(text, jsonUid, uidMatches) {
  // jsonUid might be a rounded version - find the close match in raw text UIDs
  const jsonN = BigInt(jsonUid)
  for (const m of uidMatches) {
    const rawN = BigInt(m[1])
    const diff = rawN - jsonN
    if (diff >= BigInt(-1000) && diff <= BigInt(1000) && diff !== BigInt(0)) {
      // Found a close match - this is the precise version
      return m[1]
    }
    if (rawN === jsonN) {
      return m[1] // Exact match
    }
  }
  return jsonUid // No better match found
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const allTraders = new Map() // uid -> { wr, mdd, nick }
  
  function attachCapture(page, label) {
    page.on('response', async resp => {
      const url = resp.url()
      if (!url.includes('recommend') && !url.includes('rank') && !url.includes('trader')) return
      if (resp.status() >= 400) return
      try {
        const text = await resp.text()
        if (!text.startsWith('{')) return
        
        const traders = extractTradersFromRawText(text)
        let newCount = 0
        for (const [uid, data] of traders) {
          if (!allTraders.has(uid) && data.mdd != null) {
            allTraders.set(uid, data)
            newCount++
            
            if (targetUids.has(uid)) {
              console.log(`  🎯 TARGET FOUND: ${uid} (${data.nick}) mdd=${data.mdd}`)
            }
          } else if (!allTraders.has(uid)) {
            allTraders.set(uid, data) // Store even without MDD
          }
        }
        
        if (traders.size > 0) {
          const shortUrl = url.replace(/\?.*$/, '').split('/').slice(-2).join('/')
          const hasMDD = [...traders.values()].some(t => t.mdd != null)
          console.log(`  [${label}] ${shortUrl}: ${traders.size} traders, ${newCount} new with MDD, total=${allTraders.size}`)
        }
      } catch {}
    })
  }

  const page = await ctx.newPage()
  attachCapture(page, 'main')

  console.log('Loading BingX...')
  await page.goto('https://bingx.com/en/copytrading', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  }).catch(() => {})
  await sleep(4000)

  // Paginate using v7 approach
  console.log('\nPaginating recommend list...')
  for (let p = 0; p < 30; p++) {
    const beforeSize = allTraders.size
    
    const missing = [...targetUids].filter(u => {
      const t = allTraders.get(u)
      return !t || t.mdd == null
    })
    
    if (missing.length === 0) {
      console.log('All targets found!')
      break
    }
    
    // v7's pagination approach
    let clicked = false
    try {
      const cells = await page.locator('.page-cell').all()
      if (cells.length > 0) {
        // Find active, click next
        let activeIdx = -1
        for (let i = 0; i < cells.length; i++) {
          const isActive = await cells[i].evaluate(el =>
            el.classList.contains('active')
          ).catch(() => false)
          if (isActive) { activeIdx = i; break }
        }
        
        if (activeIdx >= 0 && activeIdx + 1 < cells.length) {
          await cells[activeIdx + 1].click()
          clicked = true
        } else if (cells.length > 0) {
          // Click last cell (next arrow)
          const lastCell = cells[cells.length - 1]
          const lastText = (await lastCell.textContent().catch(() => '')).trim()
          if (lastText !== '...' && !lastText.match(/^\d+$/)) {
            await lastCell.click()
            clicked = true
          }
        }
      }
    } catch (e) {}

    if (!clicked) {
      try {
        // Try list items
        const lis = await page.locator('.bx-pagination li:not(.disabled):not(.active)').all()
        if (lis.length > 0) {
          const lastLi = lis[lis.length - 1]
          await lastLi.click()
          clicked = true
        }
      } catch {}
    }

    await sleep(2000)
    
    const afterSize = allTraders.size
    console.log(`  Page ${p + 2}: clicked=${clicked}, +${afterSize - beforeSize} traders (total=${afterSize}, missing=${missing.length})`)
    
    if (!clicked && p > 0) {
      console.log('Cannot find next page button. Stopping.')
      break
    }
  }

  // Summary
  console.log(`\nTotal traders captured: ${allTraders.size}`)
  
  const foundTargets = [...targetUids].filter(u => {
    const t = allTraders.get(u)
    return t && t.mdd != null
  })
  const missingTargets = [...targetUids].filter(u => {
    const t = allTraders.get(u)
    return !t || t.mdd == null
  })
  
  console.log(`Target UIDs found (with MDD): ${foundTargets.length}/${targetUids.size}`)
  console.log(`Still missing: ${missingTargets.length}`)
  
  if (missingTargets.length > 0) {
    console.log('\nMissing targets:')
    for (const uid of missingTargets.slice(0, 15)) {
      const t = allTraders.get(uid)
      console.log(`  ${uid} → ${t ? `in map, mdd=${t.mdd}` : 'NOT IN MAP'}`)
    }
    
    // Fuzzy check: are any of our targets near-matches to API UIDs?
    console.log('\nFuzzy matching analysis:')
    const apiUids = [...allTraders.keys()]
    for (const tuid of missingTargets.slice(0, 10)) {
      const tn = BigInt(tuid)
      const fuzzy = apiUids.find(u => {
        const un = BigInt(u)
        const diff = un - tn
        return diff >= BigInt(-10000) && diff <= BigInt(10000)
      })
      if (fuzzy) {
        console.log(`  ${tuid} → fuzzy match: ${fuzzy} (diff=${BigInt(fuzzy) - tn})`)
      } else {
        console.log(`  ${tuid} → no fuzzy match (truly not in API)`)
      }
    }
  }

  // Spot check
  console.log('\nSample of all captured UIDs:')
  const sampleUids = [...allTraders.keys()].slice(0, 10)
  for (const uid of sampleUids) {
    const t = allTraders.get(uid)
    console.log(`  ${uid}: ${t.nick}, mdd=${t.mdd}`)
  }
  
  await browser.close()
  console.log('\nDone')
}

main().catch(e => { console.error(e); process.exit(1) })
