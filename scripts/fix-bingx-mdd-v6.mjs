#!/usr/bin/env node
/**
 * BingX MDD Fix v6 - Response Interception (No Headers Needed)
 *
 * Strategy:
 *  - Open BingX leaderboard page (futures, then spot)
 *  - Install response interceptor via route handler
 *  - Let Playwright intercept ALL /copy-trade-facade/ responses
 *  - Navigate through all pages via UI clicks
 *  - Match against DB target UIDs and update DB
 *
 * Key difference from v5: we INTERCEPT RESPONSES (not request headers).
 * No need for the `sign` header since we're not making new requests.
 * The page makes its own signed requests, we just read the responses.
 *
 * Does NOT use waitUntil: networkidle (the cause of all previous timeouts)
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const DRY_RUN = process.argv.includes('--dry-run')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Parsers ─────────────────────────────────────────────────────────────────
function parseWR(v) {
  if (v == null || v === '--' || v === '') return null
  const f = parseFloat(String(v).replace('%', '').trim())
  if (isNaN(f)) return null
  if (f > 0 && f <= 1) return Math.round(f * 10000) / 100
  return Math.round(f * 100) / 100
}

function parseMDD(v) {
  if (v == null || v === '--' || v === '') return null
  const s = String(v).replace('%', '').trim()
  if (s === '0' || s === '0.00') return 0
  const f = parseFloat(s.replace('-', ''))
  if (isNaN(f)) return null
  const abs = Math.abs(f)
  if (abs > 0 && abs <= 1) return Math.round(abs * 10000) / 100
  return Math.round(abs * 100) / 100
}

function extractFromStat(stat) {
  if (!stat || typeof stat !== 'object') return { wr: null, mdd: null }
  
  const wr = parseWR(
    stat.winRate ?? stat.winRate30d ?? stat.winRate90d ?? stat.winRateStr
  )
  
  // Try all possible MDD field names
  const mddCandidates = [
    stat.maxDrawDown,
    stat.maxDrawDown30d,
    stat.maxDrawDown90d,
    stat.maxDrawDown7d,
    stat.maximumDrawDown,
    stat.maxDrawDown180d,
    stat.maxDrawdown,
    stat.mdd
  ]
  const mddRaw = mddCandidates.find(v => v != null && v !== '' && v !== '--')
  const mdd = parseMDD(mddRaw)
  
  return { wr, mdd }
}

// ─── DB queries ──────────────────────────────────────────────────────────────
console.log('Loading target UIDs from DB...')

const { data: futuresRows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown, source')
  .eq('source', 'bingx')
  .is('max_drawdown', null)

const { data: spotMddRows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown, source')
  .eq('source', 'bingx_spot')
  .is('max_drawdown', null)

const { data: spotWrRows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown, source')
  .eq('source', 'bingx_spot')
  .is('win_rate', null)

// Combine spot rows
const spotRows = [...(spotMddRows || []), ...(spotWrRows || [])].filter(
  (row, i, arr) => arr.findIndex(r => r.id === row.id) === i
)

console.log(`Futures with NULL mdd: ${futuresRows?.length || 0}`)
console.log(`Spot with NULL mdd: ${spotMddRows?.length || 0}`)
console.log(`Spot with NULL win_rate: ${spotWrRows?.length || 0}`)
console.log(`Total spot to enrich: ${spotRows.length}`)

const futuresUidSet = new Set((futuresRows || []).map(r => r.source_trader_id))
const spotHandleSet = new Set((spotRows || []).map(r => r.source_trader_id))

// ─── Launch browser ──────────────────────────────────────────────────────────
console.log('\nLaunching browser...')
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
})
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
})

// ─── FUTURES ─────────────────────────────────────────────────────────────────
const futuresMap = new Map() // uid -> { wr, mdd }

if (futuresUidSet.size > 0) {
  console.log('\n=== FUTURES PHASE ===')
  const page = await ctx.newPage()

  // Intercept ALL copy-trade-facade responses
  await page.route('**/copy-trade-facade/**', async route => {
    const req = route.request()
    try {
      const response = await route.fetch()
      const body = await response.text()
      try {
        const data = JSON.parse(body)
        if (data?.data?.result && Array.isArray(data.data.result)) {
          for (const item of data.data.result) {
            const trader = item.trader || {}
            const uid = String(trader.uid || '')
            const rs = item.rankStat || {}
            const { wr, mdd } = extractFromStat(rs)
            if (uid) futuresMap.set(uid, { wr, mdd, nick: trader.nickName || '' })
          }
          console.log(`  Captured ${data.data.result.length} traders (total: ${futuresMap.size})`)
        }
      } catch(e) {}
      await route.fulfill({ response, body })
    } catch(e) {
      await route.continue()
    }
  })

  // Navigate - use domcontentloaded for speed
  console.log('  Navigating to futures leaderboard...')
  await page.goto('https://bingx.com/en/copytrading', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  }).catch(e => console.log('  Nav warning:', e.message.substring(0, 60)))

  // Wait a bit for initial content
  await sleep(3000)

  // Click Leaderboard tab if visible
  try {
    const lb = page.locator('text=Leaderboard').first()
    if (await lb.isVisible({ timeout: 5000 })) {
      await lb.click()
      await sleep(2000)
      console.log('  Clicked Leaderboard tab')
    }
  } catch(e) {}

  // Paginate through pages
  console.log('  Paginating...')
  let missingCount = futuresUidSet.size
  let maxPages = 120
  let stuckCount = 0
  let prevSize = futuresMap.size

  for (let p = 0; p < maxPages; p++) {
    // Check if we've found all targets
    const stillMissing = [...futuresUidSet].filter(uid => {
      const entry = futuresMap.get(uid)
      return !entry || entry.mdd == null
    })
    console.log(`  Page ${p + 1}: captured=${futuresMap.size}, still missing targets=${stillMissing.length}`)

    if (stillMissing.length === 0) {
      console.log('  ✅ All target UIDs found!')
      break
    }

    // Try next page via pagination buttons
    try {
      // Look for "next page" or specific page buttons
      const nextBtn = page.locator('.bx-pagination .page-cell:not(.active):not([disabled])').last()
      const isVisible = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)
      
      if (!isVisible) {
        // Try clicking the ellipsis or input page number
        const pageInput = page.locator('.bx-pagination input').first()
        if (await pageInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await pageInput.fill(String(p + 2))
          await pageInput.press('Enter')
          await sleep(1500)
        } else {
          console.log('  No more pagination visible')
          break
        }
      } else {
        // Find the next sequential page button
        const cells = await page.locator('.page-cell').all()
        let clicked = false
        for (const cell of cells) {
          const text = await cell.textContent().catch(() => '')
          const isActive = await cell.evaluate(el => el.classList.contains('active')).catch(() => false)
          if (!isActive && text && parseInt(text) === p + 2) {
            await cell.click()
            clicked = true
            break
          }
        }
        if (!clicked) {
          // Just click the next arrow/button
          const arrows = page.locator('.bx-pagination [class*="next"], .bx-pagination li:last-child')
          if (await arrows.isVisible({ timeout: 2000 }).catch(() => false)) {
            await arrows.click()
          } else {
            console.log('  Could not find next page button')
            break
          }
        }
        await sleep(1500)
      }
    } catch(e) {
      console.log(`  Pagination error at page ${p + 1}: ${e.message.substring(0, 60)}`)
      stuckCount++
      if (stuckCount >= 3) {
        console.log('  Too many errors, stopping pagination')
        break
      }
      await sleep(2000)
    }

    // Check if we're making progress
    if (futuresMap.size === prevSize) {
      stuckCount++
      if (stuckCount >= 5) {
        console.log('  No new data for 5 pages, stopping')
        break
      }
    } else {
      stuckCount = 0
      prevSize = futuresMap.size
    }
  }

  await page.close()
}

// ─── SPOT ─────────────────────────────────────────────────────────────────
const spotMap = new Map() // handle -> { wr, mdd }

if (spotHandleSet.size > 0) {
  console.log('\n=== SPOT PHASE ===')
  console.log('Target handles:', [...spotHandleSet].join(', '))

  const spotPage = await ctx.newPage()

  // Intercept spot API responses
  await spotPage.route('**/copy-trade-facade/**', async route => {
    const req = route.request()
    try {
      const response = await route.fetch()
      const body = await response.text()
      try {
        const data = JSON.parse(body)
        // Spot API returns trader with handle/uid in different places
        if (data?.data?.result && Array.isArray(data.data.result)) {
          for (const item of data.data.result) {
            const trader = item.trader || {}
            const handle = trader.identifier || trader.handle || trader.nickName || trader.accountName || ''
            const uid = String(trader.uid || '')
            const rs = item.rankStat || {}
            const { wr, mdd } = extractFromStat(rs)
            
            // Try to match by handle
            if (handle) {
              const slug = handle.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/, '').slice(0, 50)
              if (spotHandleSet.has(slug) || spotHandleSet.has(handle)) {
                spotMap.set(slug, { wr, mdd, handle, uid })
                console.log(`  Spot found: ${slug} mdd=${mdd} wr=${wr}`)
              }
            }
            // Also store by uid
            if (uid) spotMap.set('uid:' + uid, { wr, mdd, handle, uid })
          }
        }
      } catch(e) {}
      await route.fulfill({ response, body })
    } catch(e) {
      await route.continue()
    }
  })

  console.log('  Navigating to spot copytrading...')
  await spotPage.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  }).catch(e => console.log('  Nav warning:', e.message.substring(0, 60)))

  await sleep(4000)

  // Click Leaderboard tab
  try {
    const lb = spotPage.locator('text=Leaderboard').first()
    if (await lb.isVisible({ timeout: 5000 })) {
      await lb.click()
      await sleep(2000)
    }
  } catch(e) {}

  // Paginate through spot leaderboard pages
  let prevSize = spotMap.size
  let stuckCount = 0

  for (let p = 0; p < 50; p++) {
    const stillMissing = [...spotHandleSet].filter(h => {
      const entry = spotMap.get(h)
      return !entry || (entry.mdd == null && entry.wr == null)
    })
    console.log(`  Spot page ${p + 1}: captured=${spotMap.size}, still missing=${stillMissing.length}`)

    if (stillMissing.length === 0) {
      console.log('  ✅ All spot handles found!')
      break
    }

    try {
      const cells = await spotPage.locator('.page-cell').all()
      let clicked = false
      for (const cell of cells) {
        const text = await cell.textContent().catch(() => '')
        const isActive = await cell.evaluate(el => el.classList.contains('active')).catch(() => false)
        if (!isActive && text && parseInt(text) === p + 2) {
          await cell.click()
          clicked = true
          break
        }
      }
      if (!clicked) break
      await sleep(1500)
    } catch(e) {
      stuckCount++
      if (stuckCount >= 3) break
    }
  }

  await spotPage.close()
}

await browser.close()

// ─── DB UPDATE ───────────────────────────────────────────────────────────────
console.log('\n=== DB UPDATE ===')
console.log(`Futures map size: ${futuresMap.size}`)
console.log(`Spot map size: ${spotMap.size}`)

let futuresUpdated = 0
let spotUpdated = 0
const errors = []

// Update futures
for (const row of (futuresRows || [])) {
  const uid = row.source_trader_id
  const data = futuresMap.get(uid)
  if (!data) {
    console.log(`  MISSING: futures uid ${uid}`)
    continue
  }
  
  const updates = {}
  if (data.mdd != null && row.max_drawdown == null) updates.max_drawdown = data.mdd
  if (data.wr != null && row.win_rate == null) updates.win_rate = data.wr
  
  if (Object.keys(updates).length === 0) {
    console.log(`  SKIP: futures uid ${uid} - no new data (mdd=${data.mdd}, wr=${data.wr})`)
    continue
  }
  
  if (DRY_RUN) {
    console.log(`  DRY-RUN: futures uid ${uid} -> ${JSON.stringify(updates)}`)
    futuresUpdated++
    continue
  }
  
  const { error } = await sb.from('leaderboard_ranks')
    .update(updates)
    .eq('source', 'bingx')
    .eq('source_trader_id', uid)
  
  if (error) {
    errors.push(`futures ${uid}: ${error.message}`)
    console.log(`  ERROR: futures uid ${uid}: ${error.message}`)
  } else {
    console.log(`  UPDATED: futures uid ${uid} -> ${JSON.stringify(updates)}`)
    futuresUpdated++
  }
}

// Update spot
for (const row of spotRows) {
  const handle = row.source_trader_id
  const slug = handle.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/, '').slice(0, 50)
  const data = spotMap.get(slug) || spotMap.get(handle)
  
  if (!data) {
    console.log(`  MISSING: spot handle ${handle}`)
    continue
  }
  
  const updates = {}
  if (data.mdd != null && row.max_drawdown == null) updates.max_drawdown = data.mdd
  if (data.wr != null && row.win_rate == null) updates.win_rate = data.wr
  
  if (Object.keys(updates).length === 0) {
    console.log(`  SKIP: spot ${handle} - no new data (mdd=${data.mdd}, wr=${data.wr})`)
    continue
  }
  
  if (DRY_RUN) {
    console.log(`  DRY-RUN: spot ${handle} -> ${JSON.stringify(updates)}`)
    spotUpdated++
    continue
  }
  
  const { error } = await sb.from('leaderboard_ranks')
    .update(updates)
    .eq('source', 'bingx_spot')
    .eq('source_trader_id', handle)
  
  if (error) {
    errors.push(`spot ${handle}: ${error.message}`)
    console.log(`  ERROR: spot ${handle}: ${error.message}`)
  } else {
    console.log(`  UPDATED: spot ${handle} -> ${JSON.stringify(updates)}`)
    spotUpdated++
  }
}

console.log('\n=== SUMMARY ===')
console.log(`Futures updated: ${futuresUpdated}/${futuresRows?.length || 0}`)
console.log(`Spot updated: ${spotUpdated}/${spotRows.length}`)
if (errors.length) console.log(`Errors: ${errors.length}`, errors)
