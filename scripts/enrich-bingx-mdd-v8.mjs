#!/usr/bin/env node
/**
 * BingX MDD Enrichment v8
 *
 * Key improvements over v7:
 * 1. Intercepts from api-app.qq-os.com (real backend, no Cloudflare)
 * 2. For futures: paginates recommend/leaderboard, then falls back to
 *    individual trader detail pages for any still-missing UIDs
 * 3. For spot: paginates spot search + direct spot leaderboard
 * 4. Handles both leaderboard_ranks and trader_snapshots tables
 *
 * Source trader IDs:
 *   bingx:      numeric UID (e.g. "1339191395874545700")
 *   bingx_spot: slugified nickname (e.g. "trader_ua" for "Trader_UA")
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

// ─── Parsers ──────────────────────────────────────────────────────────────────
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

function extractStats(stat) {
  if (!stat || typeof stat !== 'object') return { wr: null, mdd: null }
  const wrRaw = stat.winRate ?? stat.winRate90d ?? stat.winRate30d ?? stat.winRate7d
  const wr = parseWR(wrRaw)
  const mddRaw = [
    stat.maxDrawDown, stat.maxDrawdown,
    stat.maxDrawDown90d, stat.maxDrawdown90d,
    stat.maxDrawDown30d, stat.maxDrawdown30d,
    stat.maxDrawDown7d, stat.maxDrawdown7d,
    stat.maximumDrawDown, stat.mdd, stat.drawdown
  ].find(v => v != null && v !== '')
  const mdd = parseMDD(mddRaw)
  return { wr, mdd }
}

// ─── Load targets from DB ─────────────────────────────────────────────────────
console.log('=== Loading targets from DB ===')

// leaderboard_ranks - bingx futures
const { data: lrFutRows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bingx')
  .is('max_drawdown', null)

// leaderboard_ranks - bingx_spot
const { data: lrSpotMddRows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bingx_spot')
  .is('max_drawdown', null)

const { data: lrSpotWrRows } = await sb
  .from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bingx_spot')
  .is('win_rate', null)

// trader_snapshots - bingx futures
const { data: tsFutRows } = await sb
  .from('trader_snapshots')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bingx')
  .is('max_drawdown', null)

// trader_snapshots - bingx_spot
const { data: tsSpotRows } = await sb
  .from('trader_snapshots')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bingx_spot')
  .is('max_drawdown', null)

// Deduplicate spot rows
const lrSpotRows = [...(lrSpotMddRows || []), ...(lrSpotWrRows || [])]
  .filter((r, i, arr) => arr.findIndex(x => x.id === r.id) === i)

console.log(`leaderboard_ranks bingx (mdd null):      ${lrFutRows?.length || 0}`)
console.log(`leaderboard_ranks bingx_spot (mdd null): ${lrSpotRows.length}`)
console.log(`trader_snapshots bingx (mdd null):       ${tsFutRows?.length || 0}`)
console.log(`trader_snapshots bingx_spot (mdd null):  ${tsSpotRows?.length || 0}`)

// Build UID sets for futures
const futUidSet = new Set([
  ...(lrFutRows || []).map(r => r.source_trader_id),
  ...(tsFutRows || []).map(r => r.source_trader_id),
])

// Build slug set for spot
const spotSlugSet = new Set([
  ...lrSpotRows.map(r => r.source_trader_id),
  ...(tsSpotRows || []).map(r => r.source_trader_id),
])

console.log(`\nUnique futures UIDs to find: ${futUidSet.size}`)
console.log(`Unique spot slugs to find: ${spotSlugSet.size}`)
console.log('Spot slugs:', [...spotSlugSet].slice(0, 15))

// ─── Browser setup ────────────────────────────────────────────────────────────
console.log('\n=== Launching browser ===')
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
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

// ─── Shared interceptor ───────────────────────────────────────────────────────
// futuresMap: uid -> { wr, mdd, nick }
// spotMap:    slug -> { wr, mdd, nick, uid }
const futuresMap = new Map()
const spotMap = new Map()

function attachInterceptor(page, label) {
  page.on('response', async resp => {
    const url = resp.url()
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    // Only process qq-os.com or bingx API responses
    if (!url.includes('qq-os.com') && !url.includes('bingx.com/api')) return

    try {
      const json = await resp.json().catch(() => null)
      if (!json || json.code !== 0) return

      const items =
        json?.data?.result ||
        json?.data?.list ||
        json?.data?.records ||
        json?.data?.data ||
        (Array.isArray(json?.data) ? json.data : [])

      if (!Array.isArray(items) || items.length === 0) {
        // Check for single trader stat response
        const d = json?.data
        if (d && (d.rankStat || d.stat || d.traderStat)) {
          const stat = d.rankStat || d.stat || d.traderStat
          const uid = String(d.uid || d.trader?.uid || '')
          const nick = d.trader?.nickName || d.nickName || d.nickname || ''
          const { wr, mdd } = extractStats(stat)
          if (uid && uid !== '0') {
            futuresMap.set(uid, { wr, mdd, nick })
            if (mdd != null || wr != null) {
              console.log(`  [${label}] single-trader UID ${uid} (${nick}): mdd=${mdd} wr=${wr}`)
            }
          }
        }
        return
      }

      let newFut = 0, newSpot = 0
      for (const item of items) {
        const traderInfo = item.trader || item.traderInfo || item
        const stat = item.rankStat || item.stat || item.traderStat || item
        const uid = String(traderInfo.uid || traderInfo.uniqueId || item.uid || item.traderId || '')
        const nick = traderInfo.nickName || traderInfo.nickname || traderInfo.traderName || item.nickName || ''

        const { wr, mdd } = extractStats(stat)

        if (uid && uid !== '0') {
          const existing = futuresMap.get(uid)
          if (!existing || (existing.mdd == null && mdd != null)) {
            futuresMap.set(uid, { wr, mdd, nick })
            newFut++
          }
        }

        if (nick) {
          const slug = toSlug(nick)
          if (slug) {
            const existing = spotMap.get(slug)
            if (!existing || (existing.mdd == null && mdd != null)) {
              spotMap.set(slug, { wr, mdd, nick, uid })
              newSpot++
            }
          }
        }
      }

      if (newFut > 0 || newSpot > 0) {
        const shortUrl = url.replace(/\?.*$/, '').split('/').slice(-3).join('/')
        console.log(`  [${label}] ${shortUrl}: +${newFut} futures, +${newSpot} spot (total F=${futuresMap.size} S=${spotMap.size})`)
      }
    } catch {}
  })
}

// ─── PHASE 1: Main copy trading page + recommend pagination ──────────────────
console.log('\n=== PHASE 1: Futures leaderboard pagination ===')
const mainPage = await ctx.newPage()
attachInterceptor(mainPage, 'main')

await mainPage.goto('https://bingx.com/en/copytrading/', {
  waitUntil: 'domcontentloaded', timeout: 60000,
}).catch(e => console.log('Nav warning:', e.message.slice(0, 60)))
await sleep(5000)

// Try clicking "Leaderboard" tab
try {
  const lb = mainPage.locator('text=Leaderboard').first()
  if (await lb.isVisible({ timeout: 3000 })) {
    await lb.click()
    await sleep(2000)
    console.log('Clicked Leaderboard tab')
  }
} catch {}

// Paginate leaderboard UI
let prevFutSize = 0
let stuckCount = 0
for (let pg = 0; pg < 80; pg++) {
  const missing = [...futUidSet].filter(uid => {
    const e = futuresMap.get(uid)
    return !e || e.mdd == null
  })
  if (missing.length === 0) {
    console.log('✅ All futures UIDs found!')
    break
  }

  if (futuresMap.size === prevFutSize) {
    stuckCount++
    if (stuckCount >= 4) {
      console.log(`Stopped paginating at page ${pg + 1} (no new data for 4 pages). Still missing: ${missing.length}`)
      break
    }
  } else {
    stuckCount = 0
  }
  prevFutSize = futuresMap.size

  // Try clicking next page
  let clicked = false
  try {
    // BingX pagination: try ".page-cell.active" then get next sibling
    const nextBtn = mainPage.locator('.bx-pagination li:not(.disabled)').last()
    if (await nextBtn.isVisible({ timeout: 1000 })) {
      const txt = (await nextBtn.textContent().catch(() => '')).trim()
      if (txt && !txt.includes('...')) {
        await nextBtn.click()
        clicked = true
      }
    }
  } catch {}

  if (!clicked) {
    try {
      // Strategy 2: click right arrow / next
      const arrows = await mainPage.locator('[class*="next"], [aria-label*="next"], [aria-label*="Next"]').all()
      for (const a of arrows) {
        if (await a.isVisible({ timeout: 500 }).catch(() => false)) {
          await a.click()
          clicked = true
          break
        }
      }
    } catch {}
  }

  if (!clicked && pg > 0) {
    console.log(`  Page ${pg + 1}: Can't click next. Stopping pagination.`)
    break
  }

  await sleep(1500)
}

console.log(`After pagination: futuresMap=${futuresMap.size}, spotMap=${spotMap.size}`)

// ─── PHASE 2: Multi-rank endpoint via page.evaluate ─────────────────────────
console.log('\n=== PHASE 2: Multi-rank API via browser fetch ===')
try {
  const multiRankData = await mainPage.evaluate(async () => {
    const results = []
    for (let page = 0; page < 20; page++) {
      try {
        const r = await fetch(`https://api-app.qq-os.com/api/copy-trade-facade/v1/rank/multi-rank?pageSize=10&pageNum=${page + 1}`, {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        })
        const json = await r.json()
        if (json.code !== 0) break
        const items = json?.data?.result || json?.data?.list || json?.data?.data || []
        if (!Array.isArray(items) || items.length === 0) break
        results.push(...items.map(i => JSON.stringify(i)))
        if (items.length < 10) break
      } catch (e) {
        break
      }
    }
    return results
  })

  let multiFound = 0
  for (const itemStr of multiRankData) {
    try {
      const item = JSON.parse(itemStr)
      const traderInfo = item.trader || item.traderInfo || item
      const stat = item.rankStat || item.stat || item.traderStat || {}
      const uid = String(traderInfo.uid || traderInfo.uniqueId || item.uid || '')
      const nick = traderInfo.nickName || traderInfo.nickname || ''
      const { wr, mdd } = extractStats(stat)
      if (uid && uid !== '0') {
        const existing = futuresMap.get(uid)
        if (!existing || (existing.mdd == null && mdd != null)) {
          futuresMap.set(uid, { wr, mdd, nick })
          multiFound++
        }
      }
      if (nick) {
        const slug = toSlug(nick)
        if (slug) {
          const existing = spotMap.get(slug)
          if (!existing || (existing.mdd == null && mdd != null)) {
            spotMap.set(slug, { wr, mdd, nick, uid })
          }
        }
      }
    } catch {}
  }
  console.log(`Multi-rank: processed ${multiRankData.length} items, ${multiFound} new/updated`)
} catch (e) {
  console.log(`Multi-rank error: ${e.message}`)
}

// ─── PHASE 3: Per-trader detail pages for still-missing futures UIDs ─────────
const missingUids = [...futUidSet].filter(uid => {
  const e = futuresMap.get(uid)
  return !e || e.mdd == null
})
console.log(`\n=== PHASE 3: Per-trader detail pages (${missingUids.length} missing) ===`)

if (missingUids.length > 0) {
  const detailPage = await ctx.newPage()
  attachInterceptor(detailPage, 'detail')

  for (let i = 0; i < missingUids.length; i++) {
    const uid = missingUids[i]
    const before = futuresMap.get(uid)
    
    console.log(`  [${i + 1}/${missingUids.length}] UID ${uid}`)
    
    try {
      const url = `https://bingx.com/en/copytrading/tradeDetail/${uid}`
      await detailPage.goto(url, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      }).catch(() => {})
      await sleep(3000)

      // Also try triggering the stat API via page.evaluate
      try {
        const statResult = await detailPage.evaluate(async (uid) => {
          try {
            // Try multiple endpoints for trader stat
            const endpoints = [
              {
                url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/stat?uid=${uid}&timeType=3`,
                method: 'GET'
              },
              {
                url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/stat`,
                method: 'POST',
                body: JSON.stringify({ uid: parseInt(uid), timeType: 3 })
              },
              {
                url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/detail`,
                method: 'POST',
                body: JSON.stringify({ uid: parseInt(uid) })
              },
              {
                url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/rank?uid=${uid}`,
                method: 'GET'
              },
            ]
            for (const ep of endpoints) {
              try {
                const opts = {
                  method: ep.method,
                  credentials: 'include',
                  headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
                }
                if (ep.body) opts.body = ep.body
                const r = await fetch(ep.url, opts)
                const json = await r.json()
                if (json.code === 0 && json.data) {
                  const stat = json.data.rankStat || json.data.stat || json.data.traderStat || json.data
                  const mddCandidates = ['maxDrawDown', 'maxDrawdown', 'maxDrawDown90d', 'maxDrawdown90d',
                    'maxDrawDown30d', 'maxDrawDown7d', 'maximumDrawDown']
                  const wrCandidates = ['winRate', 'winRate90d', 'winRate30d', 'winRate7d']
                  let mdd = null, wr = null
                  for (const k of mddCandidates) if (stat[k] != null) { mdd = stat[k]; break }
                  for (const k of wrCandidates) if (stat[k] != null) { wr = stat[k]; break }
                  if (mdd != null) {
                    return { found: true, endpoint: ep.url, mdd, wr, rawStat: JSON.stringify(stat).slice(0, 500) }
                  }
                }
              } catch {}
            }
            return { found: false }
          } catch (e) {
            return { found: false, error: e.message }
          }
        }, uid)

        if (statResult.found) {
          const mdd = parseMDD(statResult.mdd)
          const wr = parseWR(statResult.wr)
          const existing = futuresMap.get(uid)
          if (!existing || (existing.mdd == null && mdd != null)) {
            futuresMap.set(uid, { wr, mdd, nick: existing?.nick || '' })
            console.log(`    ✓ Found via API: mdd=${mdd} wr=${wr} (from ${statResult.endpoint.split('/').slice(-2).join('/')})`)
          }
        }
      } catch (e) {
        console.log(`    evaluate error: ${e.message.slice(0, 60)}`)
      }

      // Check what we captured from response interceptor
      const after = futuresMap.get(uid)
      if (after && after.mdd != null && (!before || before.mdd == null)) {
        console.log(`    ✓ Found via interceptor: mdd=${after.mdd} wr=${after.wr}`)
      } else if (!after || after.mdd == null) {
        console.log(`    ✗ Still not found`)
      }
    } catch (e) {
      console.log(`    Error: ${e.message.slice(0, 80)}`)
    }

    // Don't hammer the server
    if (i < missingUids.length - 1) await sleep(500)
  }

  await detailPage.close()
}

// ─── PHASE 4: Spot leaderboard ───────────────────────────────────────────────
console.log('\n=== PHASE 4: Spot leaderboard ===')
const spotPage = await ctx.newPage()
attachInterceptor(spotPage, 'spot')

await spotPage.goto('https://bingx.com/en/CopyTrading?type=spot', {
  waitUntil: 'domcontentloaded', timeout: 60000,
}).catch(e => console.log('Spot nav warning:', e.message.slice(0, 60)))
await sleep(5000)

// Try clicking "Leaderboard" tab
try {
  const lb = spotPage.locator('text=Leaderboard').first()
  if (await lb.isVisible({ timeout: 3000 })) {
    await lb.click()
    await sleep(2000)
    console.log('Spot: clicked Leaderboard tab')
  }
} catch {}

// Paginate spot leaderboard
let prevSpotSize = 0
let spotStuck = 0
for (let pg = 0; pg < 50; pg++) {
  const missing = [...spotSlugSet].filter(slug => {
    const e = spotMap.get(slug)
    return !e || e.mdd == null
  })
  if (missing.length === 0) {
    console.log('✅ All spot slugs found!')
    break
  }
  if (spotMap.size === prevSpotSize) {
    spotStuck++
    if (spotStuck >= 4) {
      console.log(`Spot: stopped at page ${pg + 1} (stuck). Still missing: ${missing.length}`)
      break
    }
  } else {
    spotStuck = 0
  }
  prevSpotSize = spotMap.size

  let clicked = false
  try {
    const nextBtn = spotPage.locator('.bx-pagination li:not(.disabled)').last()
    if (await nextBtn.isVisible({ timeout: 1000 })) {
      const txt = (await nextBtn.textContent().catch(() => '')).trim()
      if (txt && !txt.includes('...')) {
        await nextBtn.click()
        clicked = true
      }
    }
  } catch {}

  if (!clicked && pg > 0) break
  await sleep(1500)
}

// Try spot search API via browser fetch for each missing spot slug
const missingSpotSlugs = [...spotSlugSet].filter(slug => {
  const e = spotMap.get(slug)
  return !e || e.mdd == null
})
console.log(`After spot pagination: spotMap=${spotMap.size}, still missing=${missingSpotSlugs.length}`)

if (missingSpotSlugs.length > 0) {
  console.log('Trying spot search API for missing traders...')
  console.log('Missing spot slugs:', missingSpotSlugs)
  
  // Try to paginate more pages via direct API call
  try {
    const spotApiData = await spotPage.evaluate(async () => {
      const allItems = []
      for (let pageId = 0; pageId < 10; pageId++) {
        try {
          const r = await fetch(`https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search?pageId=${pageId}&pageSize=20`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: '{}'
          })
          const json = await r.json()
          if (json.code !== 0) break
          const items = json?.data?.result || []
          if (items.length === 0) break
          allItems.push(...items.map(i => JSON.stringify(i)))
          if (items.length < 20) break
        } catch { break }
      }
      return allItems
    })

    let spotApiFound = 0
    for (const itemStr of spotApiData) {
      try {
        const item = JSON.parse(itemStr)
        const traderInfo = item.trader || item.traderInfo || item
        const stat = item.rankStat || item.stat || {}
        const nick = traderInfo.nickName || traderInfo.nickname || traderInfo.traderName || item.nickName || ''
        const uid = String(traderInfo.uid || '')
        const { wr, mdd } = extractStats(stat)
        if (nick) {
          const slug = toSlug(nick)
          if (slug) {
            const existing = spotMap.get(slug)
            if (!existing || (existing.mdd == null && mdd != null)) {
              spotMap.set(slug, { wr, mdd, nick, uid })
              if (spotSlugSet.has(slug)) {
                console.log(`  ✓ Spot API found "${nick}" (slug: ${slug}): mdd=${mdd} wr=${wr}`)
                spotApiFound++
              }
            }
          }
        }
      } catch {}
    }
    console.log(`Spot API: processed ${spotApiData.length} items, ${spotApiFound} targets found`)
  } catch (e) {
    console.log(`Spot API error: ${e.message}`)
  }
}

await spotPage.close()
await mainPage.close().catch(() => {})
await browser.close()

// ─── DB UPDATES ───────────────────────────────────────────────────────────────
console.log('\n=== DB UPDATES ===')
console.log(`futuresMap size: ${futuresMap.size}`)
console.log(`spotMap size: ${spotMap.size}`)

// Show sample of what we found for targets
const foundFut = [...futUidSet].filter(uid => {
  const e = futuresMap.get(uid)
  return e && e.mdd != null
})
const stillMissingFut = [...futUidSet].filter(uid => {
  const e = futuresMap.get(uid)
  return !e || e.mdd == null
})
console.log(`Futures targets found: ${foundFut.length}/${futUidSet.size}`)
if (stillMissingFut.length > 0) {
  console.log(`Still missing futures UIDs (${stillMissingFut.length}):`, stillMissingFut.slice(0, 10))
}

const foundSpot = [...spotSlugSet].filter(slug => {
  const e = spotMap.get(slug)
  return e && e.mdd != null
})
const stillMissingSpot = [...spotSlugSet].filter(slug => {
  const e = spotMap.get(slug)
  return !e || e.mdd == null
})
console.log(`Spot targets found: ${foundSpot.length}/${spotSlugSet.size}`)
if (stillMissingSpot.length > 0) {
  console.log(`Still missing spot slugs (${stillMissingSpot.length}):`, stillMissingSpot)
}

let lrFutUpdated = 0, lrFutMissed = 0
let lrSpotUpdated = 0, lrSpotMissed = 0
let tsFutUpdated = 0, tsFutMissed = 0
let tsSpotUpdated = 0, tsSpotMissed = 0
const errors = []

// Helper: update a table row
async function updateRow(table, row, source, data, label) {
  const updates = {}
  if (data.mdd != null && row.max_drawdown == null) updates.max_drawdown = data.mdd
  if (data.wr != null && row.win_rate == null) updates.win_rate = data.wr
  if (Object.keys(updates).length === 0) return false

  if (DRY_RUN) {
    console.log(`  DRY [${table}] ${label}: ${JSON.stringify(updates)}`)
    return true
  }

  const { error } = await sb.from(table).update(updates).eq('id', row.id)
  if (error) {
    errors.push(`${table} id=${row.id}: ${error.message}`)
    return false
  }
  console.log(`  UPDATED [${table}] ${label}: ${JSON.stringify(updates)}`)
  return true
}

// leaderboard_ranks - futures
for (const row of (lrFutRows || [])) {
  const data = futuresMap.get(row.source_trader_id)
  if (!data || data.mdd == null) {
    lrFutMissed++
    continue
  }
  const ok = await updateRow('leaderboard_ranks', row, 'bingx', data, `UID ${row.source_trader_id}`)
  if (ok) lrFutUpdated++; else lrFutMissed++
}

// leaderboard_ranks - spot
for (const row of lrSpotRows) {
  const slug = row.source_trader_id
  const data = spotMap.get(slug)
  if (!data || (data.mdd == null && data.wr == null)) {
    lrSpotMissed++
    continue
  }
  const ok = await updateRow('leaderboard_ranks', row, 'bingx_spot', data, `slug "${slug}"`)
  if (ok) lrSpotUpdated++; else lrSpotMissed++
}

// trader_snapshots - futures
for (const row of (tsFutRows || [])) {
  const data = futuresMap.get(row.source_trader_id)
  if (!data || data.mdd == null) {
    tsFutMissed++
    continue
  }
  const ok = await updateRow('trader_snapshots', row, 'bingx', data, `UID ${row.source_trader_id}`)
  if (ok) tsFutUpdated++; else tsFutMissed++
}

// trader_snapshots - spot
for (const row of (tsSpotRows || [])) {
  const slug = row.source_trader_id
  const data = spotMap.get(slug)
  if (!data || (data.mdd == null && data.wr == null)) {
    tsSpotMissed++
    continue
  }
  const ok = await updateRow('trader_snapshots', row, 'bingx_spot', data, `slug "${slug}"`)
  if (ok) tsSpotUpdated++; else tsSpotMissed++
}

// ─── FINAL REPORT ─────────────────────────────────────────────────────────────
console.log('\n=== FINAL REPORT ===')
console.log(`leaderboard_ranks bingx:      ${lrFutUpdated} updated, ${lrFutMissed} missed/skipped`)
console.log(`leaderboard_ranks bingx_spot: ${lrSpotUpdated} updated, ${lrSpotMissed} missed/skipped`)
console.log(`trader_snapshots bingx:       ${tsFutUpdated} updated, ${tsFutMissed} missed/skipped`)
console.log(`trader_snapshots bingx_spot:  ${tsSpotUpdated} updated, ${tsSpotMissed} missed/skipped`)

const totalUpdated = lrFutUpdated + lrSpotUpdated + tsFutUpdated + tsSpotUpdated
const totalMissed = lrFutMissed + lrSpotMissed + tsFutMissed + tsSpotMissed
console.log(`\nTOTAL: ${totalUpdated} rows updated, ${totalMissed} missed`)

if (errors.length > 0) {
  console.log(`\nErrors (${errors.length}):`)
  for (const e of errors) console.log(`  ${e}`)
}

// Show any remaining missing futures UIDs for investigation
if (stillMissingFut.length > 0) {
  console.log('\n⚠️  Still missing futures UIDs (traders not found in any API):')
  for (const uid of stillMissingFut) {
    console.log(`  ${uid}`)
  }
  console.log('These may be historical/inactive traders no longer on BingX leaderboard')
}

if (stillMissingSpot.length > 0) {
  console.log('\n⚠️  Still missing spot slugs:')
  for (const slug of stillMissingSpot) {
    console.log(`  ${slug}`)
  }
}

console.log('\nDone!')
