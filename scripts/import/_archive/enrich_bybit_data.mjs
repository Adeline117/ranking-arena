#!/usr/bin/env node
/**
 * Bybit & Bybit Spot Enrichment Script
 * 
 * Fetches the full leader list via browser-based API calls to fill missing
 * max_drawdown, win_rate, pnl fields in trader_snapshots.
 * Only UPDATEs NULL fields — never overwrites existing data.
 * 
 * Usage: node scripts/import/enrich_bybit_data.mjs [bybit|bybit_spot|all]
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())
const supabase = getSupabaseClient()

const PROXY = 'http://127.0.0.1:7890'
const PAGE_SIZE = 50
const BASE_URL = 'https://www.bybit.com/copyTrade/'
const API_PATH = '/x-api/fapi/beehive/public/v1/common/dynamic-leader-list'

const PERIOD_MAP = {
  '7D': 'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
}

function parsePercent(s) {
  if (!s && s !== 0) return null
  const m = String(s).replace(/,/g, '').match(/([+-]?)(\d+(?:\.\d+)?)%?/)
  if (!m) return null
  return parseFloat(m[2]) * (m[1] === '-' ? -1 : 1)
}

function parseNumber(s) {
  if (!s && s !== 0) return null
  const v = parseFloat(String(s).replace(/[^0-9.\-+]/g, ''))
  return isNaN(v) ? null : v
}

async function fetchAllLeaders(page, period) {
  const duration = PERIOD_MAP[period]
  const allTraders = []
  const seenIds = new Set()

  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    const url = `${API_PATH}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`

    const result = await page.evaluate(async (apiUrl) => {
      try {
        const resp = await fetch(apiUrl)
        return await resp.json()
      } catch (e) { return { error: e.message } }
    }, url)

    if (result.error) { console.log(`  ⚠ Page ${pageNo} error: ${result.error}`); break }

    const details = result?.result?.leaderDetails || []
    if (details.length === 0) break

    for (const item of details) {
      const id = String(item.leaderUserId || item.leaderMark || '')
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)

      const mv = item.metricValues || []
      allTraders.push({
        traderId: id,
        roi: parsePercent(mv[0]),
        maxDrawdown: parsePercent(mv[1]),
        pnl: parseNumber(mv[2]),
        winRate: parsePercent(mv[3]),
      })
    }

    console.log(`  Page ${pageNo}: ${details.length} items, total ${allTraders.length}`)
    if (allTraders.length >= 600) break
    await sleep(800)
  }

  return allTraders
}

async function enrichSource(source, period) {
  console.log(`\n=== Enriching ${source} ${period} ===`)

  // 1. Get existing traders with missing data
  const { data: existing, error: dbErr } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, arena_score')
    .eq('source', source)
    .eq('season_id', period)

  if (dbErr) { console.error('DB error:', dbErr.message); return }
  console.log(`  ${existing.length} existing snapshots`)

  const needsEnrichment = existing.filter(t =>
    t.win_rate === null || t.max_drawdown === null || t.pnl === null || t.pnl === 0 ||
    (t.roi === null || t.roi === 0)
  )
  console.log(`  ${needsEnrichment.length} need enrichment`)

  if (needsEnrichment.length === 0) {
    console.log('  ✅ All data complete!')
    return
  }

  // 2. Launch browser and fetch API data
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--proxy-server=${PROXY}`,
    ],
    timeout: 60000,
  })

  let apiTraders = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    console.log('  Loading Bybit page for session...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
    } catch { console.log('  ⚠ Page load timeout, continuing...') }
    await sleep(3000)

    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button, div, span').forEach(el => {
        const t = (el.textContent || '').toLowerCase()
        if (t.includes("don't live") || t.includes('confirm') || t.includes('got it') ||
            t.includes('close') || t.includes('ok') || t.includes('accept')) {
          try { el.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(1000)

    apiTraders = await fetchAllLeaders(page, period)
    console.log(`  Fetched ${apiTraders.length} traders from API`)
    await page.close()
  } finally {
    await browser.close()
  }

  if (apiTraders.length === 0) {
    console.log('  ❌ No API data fetched')
    return
  }

  // 3. Build lookup map
  const apiMap = new Map()
  for (const t of apiTraders) {
    apiMap.set(t.traderId, t)
  }

  // 4. Update only NULL fields
  let updated = 0
  let notFound = 0

  for (const snap of needsEnrichment) {
    const api = apiMap.get(snap.source_trader_id)
    if (!api) { notFound++; continue }

    const updates = {}
    if ((snap.roi === null || snap.roi === 0) && api.roi !== null) updates.roi = api.roi
    if (snap.pnl === null || snap.pnl === 0) {
      if (api.pnl !== null && api.pnl !== 0) updates.pnl = api.pnl
    }
    if (snap.win_rate === null && api.winRate !== null) {
      updates.win_rate = api.winRate > 0 && api.winRate <= 1 ? api.winRate * 100 : api.winRate
    }
    if (snap.max_drawdown === null && api.maxDrawdown !== null) {
      updates.max_drawdown = Math.abs(api.maxDrawdown)
    }

    if (Object.keys(updates).length === 0) continue

    // Recalculate arena_score with updated values
    const newRoi = updates.roi ?? snap.roi ?? 0
    const newPnl = updates.pnl ?? snap.pnl ?? 0
    const newWr = updates.win_rate ?? snap.win_rate ?? null
    const newMdd = updates.max_drawdown ?? snap.max_drawdown ?? null
    const { totalScore } = calculateArenaScore(newRoi, newPnl, newMdd, newWr, period)
    updates.arena_score = totalScore

    const { error } = await supabase
      .from('trader_snapshots')
      .update(updates)
      .eq('id', snap.id)

    if (!error) updated++
    else console.log(`  ⚠ Update error for ${snap.source_trader_id}: ${error.message}`)
  }

  console.log(`  ✅ Updated ${updated} snapshots, ${notFound} not found in API`)
}

async function main() {
  const arg = process.argv[2]?.toLowerCase() || 'all'
  const sources = arg === 'all' ? ['bybit', 'bybit_spot'] : [arg]
  const periods = ['7D', '30D', '90D']

  for (const source of sources) {
    for (const period of periods) {
      await enrichSource(source, period)
    }
  }

  console.log('\n=== Done ===')
}

main().catch(console.error)
