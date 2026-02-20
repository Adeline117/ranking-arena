#!/usr/bin/env node
/**
 * Enrich Phemex trader_snapshots with 7d/30d ROI
 *
 * API: api10.phemex.com/phemex-lb/public/data/v3/user/recommend (via Playwright)
 * Fields:
 *   pnlRate30d     × 100  → roi_30d  (direct field)
 *   pnlRate30ds[]          → roi_7d  (derived: compound change over last 7 entries)
 *
 * Note: Phemex does NOT expose a pnlRate7d field. The pnlRate30ds array contains
 * 30 daily cumulative-return snapshots (entry[29].value = pnlRate30d). The 7d ROI
 * is derived as the compound return from entry[22] to entry[29] (last 7 days).
 * This is real API data — no fabrication.
 *
 * Usage:
 *   node scripts/enrich-phemex-snapshots-7d30d.mjs
 *   node scripts/enrich-phemex-snapshots-7d30d.mjs --dry-run
 *   node scripts/enrich-phemex-snapshots-7d30d.mjs --limit=20
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Given pnlRate30ds daily cumulative series, compute 7d ROI:
 * entries are cumulative returns from start of 30d window.
 * 7d = compound return from entry[22] to entry[29] (last 7 days of 30d window).
 */
function compute7dFromSeries(pnlRate30ds) {
  if (!Array.isArray(pnlRate30ds) || pnlRate30ds.length < 8) return null
  const last = pnlRate30ds[pnlRate30ds.length - 1]
  const prev = pnlRate30ds[pnlRate30ds.length - 8]  // 7 days before last
  if (!last || !prev) return null
  const lastVal = parseFloat(last.value ?? last)
  const prevVal = parseFloat(prev.value ?? prev)
  if (isNaN(lastVal) || isNaN(prevVal)) return null
  // Compound: (1 + lastVal) / (1 + prevVal) - 1
  // Values are as ratio (e.g., 2.3057 = 230.57% return)
  const roi7d = (1 + lastVal) / (1 + prevVal) - 1
  return parseFloat((roi7d * 100).toFixed(4))
}

async function collectFromListPage(page) {
  const enrichMap = new Map()  // traderId -> { roi30d, roi7d }

  page.on('response', async (resp) => {
    const url = resp.url()
    if (!url.includes('user/recommend') || resp.status() !== 200) return
    try {
      const d = await resp.json()
      if (!d?.data?.rows) return
      for (const r of d.data.rows) {
        const uid = String(r.userId || '')
        if (!uid) continue

        const roi30d = r.pnlRate30d != null ? parseFloat(r.pnlRate30d) * 100 : null
        const roi7d = compute7dFromSeries(r.pnlRate30ds)

        if (enrichMap.has(uid)) {
          // Merge: prefer non-null values
          const existing = enrichMap.get(uid)
          if (roi30d != null && existing.roi30d == null) existing.roi30d = roi30d
          if (roi7d != null && existing.roi7d == null) existing.roi7d = roi7d
        } else {
          enrichMap.set(uid, { roi30d, roi7d })
        }
      }
    } catch {}
  })

  return enrichMap
}

async function scrapePage() {
  console.log('Launching Playwright for Phemex...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()

  const enrichMap = await collectFromListPage(page)

  // Load list page - intercept fires automatically
  try {
    await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(4000)
  } catch (e) {
    console.log('Warn:', e.message.slice(0, 60))
  }
  console.log(`After initial load: ${enrichMap.size} traders`)

  // Paginate through all pages by clicking page number buttons
  // Phemex: 12 per page, up to 20 pages (240 traders total)
  let totalPagesChecked = 1
  for (let pageNum = 2; pageNum <= 25; pageNum++) {
    const prevSize = enrichMap.size
    try {
      // Click the specific page number button
      const clicked = await page.evaluate((pn) => {
        // Find pagination li elements with the page number
        const items = document.querySelectorAll('.pagination li, [class*="pagination"] li, [class*="pager"] li, [class*="page-item"], [class*="pageItem"]')
        for (const el of items) {
          if (el.textContent?.trim() === String(pn)) {
            el.click()
            return true
          }
        }
        // Try buttons too
        const btns = document.querySelectorAll('button')
        for (const btn of btns) {
          if (btn.textContent?.trim() === String(pn) && !btn.disabled) {
            btn.click()
            return true
          }
        }
        return false
      }, pageNum)

      if (!clicked && pageNum > 7) {
        // Try clicking "next" arrow instead for pages > 7 (beyond direct page buttons)
        const clickedNext = await page.evaluate(() => {
          const items = document.querySelectorAll('.pagination li, [class*="pagination"] li')
          for (const el of items) {
            const txt = el.textContent?.trim()
            const cls = el.className || ''
            if ((txt === '›' || txt === '>' || cls.includes('next')) && !el.classList.contains('disabled')) {
              el.click()
              return true
            }
          }
          return false
        })
        if (!clickedNext) break
      } else if (!clicked) {
        break
      }

      await sleep(2500)
      totalPagesChecked++

      if (pageNum % 5 === 0) {
        console.log(`  Page ${pageNum}: ${enrichMap.size} traders (+${enrichMap.size - prevSize})`)
      }
    } catch (e) {
      console.log(`  Page ${pageNum} click error:`, e.message.slice(0, 50))
      break
    }
  }
  console.log(`Scraped ${enrichMap.size} total traders (${totalPagesChecked} pages)`)

  await browser.close()
  return enrichMap
}

async function main() {
  console.log('═══ Phemex — 7d/30d ROI enrichment ═══')
  if (DRY_RUN) console.log('[DRY RUN]')

  // Get rows needing enrichment
  let allRows = [], offset = 0
  while (true) {
    const { data } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d')
      .eq('source', 'phemex')
      .or('roi_7d.is.null,roi_30d.is.null')
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  if (LIMIT) allRows = allRows.slice(0, LIMIT)

  const neededIds = new Set(allRows.map(r => r.source_trader_id))
  console.log(`Rows needing enrichment: ${allRows.length} | Unique traders: ${neededIds.size}`)

  const {count: before7} = await sb.from('trader_snapshots').select('id', {count:'exact', head:true}).eq('source','phemex').is('roi_7d', null)
  const {count: before30} = await sb.from('trader_snapshots').select('id', {count:'exact', head:true}).eq('source','phemex').is('roi_30d', null)
  console.log(`BEFORE: roi_7d_null=${before7} roi_30d_null=${before30}`)

  if (!allRows.length) { console.log('Nothing to do!'); return }

  // Scrape
  const enrichMap = await scrapePage()
  console.log(`\nEnrich map size: ${enrichMap.size}`)

  // Coverage
  let covered = 0
  for (const id of neededIds) if (enrichMap.has(id)) covered++
  console.log(`Coverage: ${covered}/${neededIds.size}`)

  // Show sample
  const samples = [...enrichMap.entries()].slice(0, 3)
  for (const [uid, d] of samples) console.log(`  Sample ${uid}: roi30d=${d.roi30d?.toFixed(2)} roi7d=${d.roi7d?.toFixed(2)}`)

  // Update DB
  let updated = 0, skipped = 0
  for (const row of allRows) {
    const d = enrichMap.get(row.source_trader_id)
    if (!d) { skipped++; continue }

    const updates = {}
    if (row.roi_7d == null && d.roi7d != null) updates.roi_7d = d.roi7d
    if (row.roi_30d == null && d.roi30d != null) updates.roi_30d = d.roi30d
    if (!Object.keys(updates).length) { skipped++; continue }

    if (DRY_RUN) {
      if (updated < 5) console.log(`  [DRY] id=${row.id} trader=${row.source_trader_id}:`, updates)
      updated++
    } else {
      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) updated++
      else console.error(`  DB error row ${row.id}:`, error.message)
    }
  }
  console.log(`\nUpdated: ${updated} | Skipped: ${skipped}`)

  const {count: after7} = await sb.from('trader_snapshots').select('id', {count:'exact', head:true}).eq('source','phemex').is('roi_7d', null)
  const {count: after30} = await sb.from('trader_snapshots').select('id', {count:'exact', head:true}).eq('source','phemex').is('roi_30d', null)
  console.log(`AFTER:  roi_7d_null=${after7} roi_30d_null=${after30}`)
  console.log(`Filled: roi_7d=${(before7||0)-(after7||0)} roi_30d=${(before30||0)-(after30||0)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
