#!/usr/bin/env node
/**
 * BingX MDD Fix v7 - Full pagination, proper spot URL
 *
 * Improvements over v6:
 * - No "stuck" early exit for futures - goes through ALL pages
 * - Uses page.on('response') for more reliable capture
 * - Correct spot URL: /en/CopyTrading?type=spot
 * - Correct spot API: /spot/trader/search  
 * - Better pagination using next-arrow approach
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
  if (s === '0' || s === '0.00' || s === '-0' || s === '-0.00') return 0
  const f = parseFloat(s.replace('-', ''))
  if (isNaN(f)) return null
  const abs = Math.abs(f)
  if (abs > 0 && abs <= 1) return Math.round(abs * 10000) / 100
  return Math.round(abs * 100) / 100
}

function toSlug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
}

function extractFromStat(stat) {
  if (!stat || typeof stat !== 'object') return { wr: null, mdd: null }
  const wr = parseWR(
    stat.winRate ?? stat.winRate30d ?? stat.winRate90d ?? stat.winRate7d
  )
  const mddRaw = [
    stat.maxDrawDown, stat.maxDrawdown,
    stat.maxDrawDown30d, stat.maxDrawdown30d,
    stat.maxDrawDown90d, stat.maxDrawdown90d,
    stat.maximumDrawDown, stat.maxDrawDown7d,
    stat.maxDrawDown180d, stat.mdd, stat.drawdown
  ].find(v => v != null && v !== '')
  const mdd = parseMDD(mddRaw)
  return { wr, mdd }
}

// ─── DB queries ──────────────────────────────────────────────────────────────
console.log('Loading target UIDs from DB...')

const { data: futuresRows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bingx')
  .is('max_drawdown', null)

const { data: spotMddRows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bingx_spot')
  .is('max_drawdown', null)

const { data: spotWrRows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bingx_spot')
  .is('win_rate', null)

const spotRows = [...(spotMddRows || []), ...(spotWrRows || [])].filter(
  (row, i, arr) => arr.findIndex(r => r.id === row.id) === i
)

console.log(`Futures with NULL mdd: ${futuresRows?.length || 0}`)
console.log(`Total spot to enrich: ${spotRows.length}`)

const futuresUidSet = new Set((futuresRows || []).map(r => r.source_trader_id))
const spotHandleSet = new Set(spotRows.map(r => r.source_trader_id))

console.log('Spot handles:', [...spotHandleSet])

// ─── Browser setup ────────────────────────────────────────────────────────────
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

// ─── Generic pagination helper ───────────────────────────────────────────────
async function paginateLeaderboard(page, label, capturedMap, targetKeys, maxPages = 120) {
  let prevSize = capturedMap.size
  let successiveSameCount = 0

  for (let p = 0; p < maxPages; p++) {
    const missing = [...targetKeys].filter(k => {
      const e = capturedMap.get(k)
      return !e || (e.mdd == null && e.wr == null)
    })
    
    console.log(`  ${label} page ${p + 1}: captured=${capturedMap.size}, missing targets=${missing.length}`)

    if (missing.length === 0) {
      console.log(`  ✅ All ${label} targets found!`)
      break
    }

    // Find and click next page
    try {
      // Strategy 1: Find visible "p+2" numbered page cell
      let clicked = false
      const cells = await page.locator('.page-cell').all()
      for (const cell of cells) {
        const text = (await cell.textContent().catch(() => '')).trim()
        const isActive = await cell.evaluate(el => el.classList.contains('active') || el.classList.contains('disabled')).catch(() => false)
        if (!isActive && text === String(p + 2)) {
          await cell.click()
          clicked = true
          break
        }
      }

      if (!clicked) {
        // Strategy 2: Click the last non-active, non-ellipsis page cell (likely the ">" next arrow)
        const allCells = await page.locator('.bx-pagination li:not(.disabled)').all()
        if (allCells.length > 0) {
          const lastCell = allCells[allCells.length - 1]
          const lastText = (await lastCell.textContent().catch(() => '')).trim()
          const isActive = await lastCell.evaluate(el => el.classList.contains('active')).catch(() => false)
          if (!isActive && lastText !== '1') {
            await lastCell.click()
            clicked = true
          }
        }
      }
      
      if (!clicked) {
        // Strategy 3: Look for a "jump to page" input
        const input = page.locator('.bx-pagination input[type="number"], .bx-pagination input').first()
        if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
          await input.fill(String(p + 2))
          await input.press('Enter')
          clicked = true
        }
      }

      if (!clicked) {
        console.log(`  ⚠ No pagination button found at page ${p + 1}, trying keyboard`)
        // Last resort - press right arrow on pagination
        await page.keyboard.press('ArrowRight').catch(() => {})
      }

      await sleep(1500)

    } catch(e) {
      console.log(`  Pagination error: ${e.message.substring(0, 60)}`)
      await sleep(2000)
    }

    // Detect if we're stuck (no new captures after 8+ consecutive pages)
    if (capturedMap.size === prevSize) {
      successiveSameCount++
      if (successiveSameCount >= 10) {
        console.log(`  No new data for 10 pages, stopping`)
        break
      }
    } else {
      successiveSameCount = 0
      prevSize = capturedMap.size
    }
  }
}

// ─── FUTURES ─────────────────────────────────────────────────────────────────
const futuresMap = new Map() // uid -> { wr, mdd }

if (futuresUidSet.size > 0) {
  console.log('\n=== FUTURES PHASE ===')
  const page = await ctx.newPage()
  
  page.on('response', async response => {
    const url = response.url()
    if (!url.includes('copy-trade-facade') && !url.includes('copytrading')) return
    if (response.status() >= 400) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json?.data?.result) return
      
      let newCount = 0
      for (const item of json.data.result) {
        const trader = item.trader || {}
        const uid = String(trader.uid || '')
        if (!uid) continue
        const rs = item.rankStat || {}
        const { wr, mdd } = extractFromStat(rs)
        futuresMap.set(uid, { wr, mdd, nick: trader.nickName || '' })
        newCount++
      }
      if (newCount > 0) console.log(`  Captured ${newCount} traders (total: ${futuresMap.size})`)
    } catch(e) {}
  })

  console.log('  Navigating to futures leaderboard...')
  await page.goto('https://bingx.com/en/copytrading', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }).catch(e => console.log('  Nav warning:', e.message.substring(0, 60)))

  await sleep(4000)

  // Click Leaderboard tab
  try {
    await page.locator('text=Leaderboard').first().click({ timeout: 5000 })
    await sleep(2000)
    console.log('  Clicked Leaderboard tab')
  } catch(e) { console.log('  No Leaderboard tab (or already on it)') }

  // Paginate through all pages
  await paginateLeaderboard(page, 'futures', futuresMap, futuresUidSet)

  // Print what we found for target UIDs
  const stillMissing = [...futuresUidSet].filter(uid => {
    const e = futuresMap.get(uid)
    return !e || e.mdd == null
  })
  console.log(`\nFutures summary: found ${futuresUidSet.size - stillMissing.length}/${futuresUidSet.size}`)
  if (stillMissing.length > 0) {
    console.log(`Still missing: ${stillMissing.join(', ')}`)
  }

  await page.close()
}

// ─── SPOT ─────────────────────────────────────────────────────────────────
const spotMap = new Map() // slug -> { wr, mdd, nickName }

if (spotHandleSet.size > 0) {
  console.log('\n=== SPOT PHASE ===')
  const spotPage = await ctx.newPage()

  spotPage.on('response', async response => {
    const url = response.url()
    if (!url.includes('copy-trade-facade') && !url.includes('spot')) return
    if (response.status() >= 400) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      let list = []
      if (Array.isArray(json?.data?.result)) list = json.data.result
      else if (Array.isArray(json?.data?.list)) list = json.data.list
      else if (Array.isArray(json?.data)) list = json.data

      let newCount = 0
      for (const item of list) {
        const traderInfo = item.trader || item
        const rankStat = item.rankStat || item.stat || item
        const nickName = traderInfo.nickName || traderInfo.name || traderInfo.traderName || ''
        const uid = String(traderInfo.uid || '')
        
        if (!nickName && !uid) continue

        const { wr, mdd } = extractFromStat(rankStat)
        const slug = toSlug(nickName)
        
        if (slug && slug.length > 0) {
          spotMap.set(slug, { wr, mdd, nickName, uid })
          newCount++
          
          // Check if this matches any of our targets
          if (spotHandleSet.has(slug) || spotHandleSet.has(nickName)) {
            console.log(`  ✓ FOUND: "${nickName}" (slug: ${slug}) mdd=${mdd} wr=${wr}`)
          }
        }
        if (uid && uid !== '0') {
          spotMap.set('uid:' + uid, { wr, mdd, nickName, uid })
        }
      }
      if (newCount > 0) console.log(`  Spot captured ${newCount} traders (url: ${url.substring(url.lastIndexOf('/'), url.length)})`)
    } catch(e) {}
  })

  // Navigate to spot copy trading
  console.log('  Navigating to spot leaderboard...')
  await spotPage.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }).catch(e => console.log('  Nav warning:', e.message.substring(0, 60)))

  await sleep(4000)

  // Click Leaderboard tab
  try {
    await spotPage.locator('text=Leaderboard').first().click({ timeout: 5000 })
    await sleep(2000)
    console.log('  Clicked Leaderboard tab')
  } catch(e) { console.log('  No Leaderboard tab click needed') }

  // Paginate
  await paginateLeaderboard(spotPage, 'spot', spotMap, spotHandleSet, 50)

  console.log('\nSpot map slug samples:', [...spotMap.keys()].slice(0,10))

  await spotPage.close()
}

await browser.close()

// ─── DB UPDATE ───────────────────────────────────────────────────────────────
console.log('\n=== DB UPDATE ===')
console.log(`Futures map size: ${futuresMap.size}`)
console.log(`Spot map size: ${spotMap.size}`)

let futuresUpdated = 0, futuresSkipped = 0
let spotUpdated = 0, spotSkipped = 0
const errors = []

// Update futures
for (const row of (futuresRows || [])) {
  const uid = row.source_trader_id
  const data = futuresMap.get(uid)
  if (!data) {
    console.log(`  MISSING: futures ${uid}`)
    futuresSkipped++
    continue
  }
  
  const updates = {}
  if (data.mdd != null && row.max_drawdown == null) updates.max_drawdown = data.mdd
  if (data.wr != null && row.win_rate == null) updates.win_rate = data.wr
  
  if (Object.keys(updates).length === 0) {
    futuresSkipped++
    continue
  }
  
  if (DRY_RUN) {
    console.log(`  DRY: futures ${uid} (${data.nick || ''}) -> ${JSON.stringify(updates)}`)
    futuresUpdated++
    continue
  }
  
  const { error } = await sb.from('leaderboard_ranks')
    .update(updates)
    .eq('source', 'bingx')
    .eq('source_trader_id', uid)
  
  if (error) {
    errors.push(`futures ${uid}: ${error.message}`)
  } else {
    console.log(`  UPDATED: futures ${uid} -> ${JSON.stringify(updates)}`)
    futuresUpdated++
  }
}

// Update spot
for (const row of spotRows) {
  const handle = row.source_trader_id
  const slug = toSlug(handle)
  const data = spotMap.get(slug) || spotMap.get(handle)
  
  if (!data) {
    console.log(`  MISSING: spot "${handle}"`)
    spotSkipped++
    continue
  }
  
  const updates = {}
  if (data.mdd != null && row.max_drawdown == null) updates.max_drawdown = data.mdd
  if (data.wr != null && row.win_rate == null) updates.win_rate = data.wr
  
  if (Object.keys(updates).length === 0) {
    console.log(`  SKIP: spot "${handle}" already has data or no new data (mdd=${data.mdd}, wr=${data.wr})`)
    spotSkipped++
    continue
  }
  
  if (DRY_RUN) {
    console.log(`  DRY: spot "${handle}" -> ${JSON.stringify(updates)}`)
    spotUpdated++
    continue
  }
  
  const { error } = await sb.from('leaderboard_ranks')
    .update(updates)
    .eq('source', 'bingx_spot')
    .eq('source_trader_id', handle)
  
  if (error) {
    errors.push(`spot ${handle}: ${error.message}`)
  } else {
    console.log(`  UPDATED: spot "${handle}" -> ${JSON.stringify(updates)}`)
    spotUpdated++
  }
}

console.log('\n=== FINAL SUMMARY ===')
console.log(`Futures updated: ${futuresUpdated}/${futuresRows?.length || 0}, skipped/missing: ${futuresSkipped}`)
console.log(`Spot updated: ${spotUpdated}/${spotRows.length}, skipped/missing: ${spotSkipped}`)
if (errors.length) console.log(`Errors (${errors.length}):`, errors)
