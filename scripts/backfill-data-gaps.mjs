#!/usr/bin/env node
/**
 * Backfill Data Gaps Script
 *
 * Fixes remaining data gaps in trader_snapshots_v2 for specific platforms:
 * - bitget_futures: ROI gap (~14%) — re-fetch from Bitget leaderboard API via VPS scraper
 * - bitfinex: ROI gap (~24%) — compute from daily snapshot first/last values
 * - okx_web3: ROI gap — re-fetch from OKX API, compute from pnlRatios
 * - gains: ROI gap (~20%) — re-fetch from Copin or on-chain sources
 * - bybit: PnL gap (~29%) — fetch from VPS scraper /bybit/trader-detail
 * - bybit_spot: PnL gap — SKIP (API only returns %, no absolute PnL without AUM)
 *
 * Usage:
 *   node scripts/backfill-data-gaps.mjs [--platform=xxx] [--limit=N] [--dry-run] [--window=30D]
 *
 * Examples:
 *   node scripts/backfill-data-gaps.mjs --dry-run
 *   node scripts/backfill-data-gaps.mjs --platform=bitget_futures
 *   node scripts/backfill-data-gaps.mjs --platform=bybit --limit=100
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

// ============ Config ============

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const VPS_SCRAPER_SG = process.env.VPS_SCRAPER_SG || process.env.VPS_SCRAPER_HOST || 'http://45.76.152.169:3457'
const VPS_PROXY_SG = process.env.VPS_PROXY_SG || 'http://45.76.152.169:3456'
const VPS_PROXY_KEY = process.env.VPS_PROXY_KEY || 'arena-proxy-sg-2026'
const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const BATCH_SIZE = 50
const BATCH_DELAY_MS = 1000
const TIMEOUT_MS = 15000
const MAX_CONCURRENT = 3

const DRY_RUN = process.argv.includes('--dry-run')
const PLATFORM_FILTER = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1] || null
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0
const WINDOW_FILTER = process.argv.find(a => a.startsWith('--window='))?.split('=')[1] || null

// ============ Helpers ============

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function safeNum(v) {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? null : n
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timer)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.json()
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

async function fetchViaScraper(path, timeoutMs = TIMEOUT_MS) {
  return await fetchWithTimeout(`${VPS_SCRAPER_SG}${path}`, {
    headers: { 'x-proxy-key': VPS_PROXY_KEY }
  }, timeoutMs)
}

async function fetchViaProxy(targetUrl, timeoutMs = TIMEOUT_MS) {
  const proxyUrl = `${VPS_PROXY_SG}?url=${encodeURIComponent(targetUrl)}`
  return await fetchWithTimeout(proxyUrl, {
    headers: { 'x-proxy-key': VPS_PROXY_KEY }
  }, timeoutMs)
}

async function fetchViaCFProxy(targetUrl, timeoutMs = TIMEOUT_MS) {
  const proxyUrl = `${CF_PROXY}?url=${encodeURIComponent(targetUrl)}`
  return await fetchWithTimeout(proxyUrl, {}, timeoutMs)
}

// ============ DB Helpers ============

/**
 * Get snapshot rows with NULL values for specific fields on a platform.
 * @param {string} platform
 * @param {string[]} nullFields - fields that should be NULL (OR condition)
 * @param {string[]} selectFields - additional fields to select
 */
async function getSnapshotsWithNulls(platform, nullFields, selectFields = []) {
  const PAGE = 1000
  const results = []
  let offset = 0

  const baseSelect = ['id', 'platform', 'trader_key', 'window', 'roi_pct', 'pnl_usd', ...selectFields]
  const orFilter = nullFields.map(f => `${f}.is.null`).join(',')

  while (true) {
    let query = supabase
      .from('trader_snapshots_v2')
      .select(baseSelect.join(', '))
      .eq('platform', platform)
      .or(orFilter)

    if (WINDOW_FILTER) {
      query = query.eq('window', WINDOW_FILTER)
    }

    const { data, error } = await query.range(offset, offset + PAGE - 1)

    if (error) { console.error(`  DB error: ${error.message}`); break }
    if (!data || data.length === 0) break
    results.push(...data)
    if (data.length < PAGE) break
    offset += PAGE
  }

  return results
}

/** Update a single snapshot row */
async function updateSnapshot(id, updates) {
  if (DRY_RUN) return true
  const { error } = await supabase
    .from('trader_snapshots_v2')
    .update(updates)
    .eq('id', id)
  if (error) {
    console.error(`  Update error for id=${id}: ${error.message}`)
    return false
  }
  return true
}

/** Deduplicate by trader_key — same trader may appear in multiple windows */
function uniqueTraderKeys(rows) {
  const seen = new Set()
  return rows.filter(r => {
    if (seen.has(r.trader_key)) return false
    seen.add(r.trader_key)
    return true
  })
}

// ============ Platform Backfill Strategies ============

/**
 * bitget_futures: ROI gap
 * Re-fetch from Bitget trader detail API via CF proxy (Bitget is CF-protected).
 * The detail endpoint returns roi, profit, winRate, drawDown per period.
 */
async function backfillBitgetFuturesRoi(rows) {
  const uniqueTraders = uniqueTraderKeys(rows)
  const limited = LIMIT > 0 ? uniqueTraders.slice(0, LIMIT) : uniqueTraders

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[bitget_futures] ROI backfill: ${rows.length} null rows, ${uniqueTraders.length} unique traders, processing ${limited.length}`)
  console.log(`${'='.repeat(60)}`)

  let success = 0, failed = 0, skipped = 0, filled = 0

  for (let i = 0; i < limited.length; i += MAX_CONCURRENT) {
    const batch = limited.slice(i, i + MAX_CONCURRENT)

    const results = await Promise.allSettled(
      batch.map(async (trader) => {
        try {
          // Bitget detail API — CF-protected, use CF proxy
          const targetUrl = `https://www.bitget.com/v1/trigger/trace/public/trader/detail?traderId=${trader.trader_key}`
          let data
          try {
            data = await fetchViaCFProxy(targetUrl)
          } catch {
            // Fallback: VPS scraper
            data = await fetchViaScraper(`/bitget/trader-detail?traderId=${trader.trader_key}`, 20000)
          }

          if (!data?.data) return { trader_key: trader.trader_key, status: 'no_data' }

          const d = data.data
          const roi = safeNum(d.roi)
          const pnl = safeNum(d.profit)

          if (roi == null && pnl == null) return { trader_key: trader.trader_key, status: 'no_data' }

          return { trader_key: trader.trader_key, status: 'ok', roi, pnl }
        } catch (e) {
          return { trader_key: trader.trader_key, status: 'error', error: e.message }
        }
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') { failed++; continue }
      const { trader_key, status, roi, pnl, error } = result.value

      if (status === 'error') {
        failed++
        if (failed <= 5) console.log(`  FAIL ${trader_key}: ${error}`)
        continue
      }
      if (status === 'no_data') { skipped++; continue }

      // Update all matching rows for this trader
      const traderRows = rows.filter(r => r.trader_key === trader_key)
      for (const row of traderRows) {
        const updates = {}
        if (row.roi_pct == null && roi != null) updates.roi_pct = roi
        if (row.pnl_usd == null && pnl != null) updates.pnl_usd = pnl
        if (Object.keys(updates).length > 0) {
          const ok = await updateSnapshot(row.id, updates)
          if (ok) filled++
        }
      }
      success++
    }

    if ((i + MAX_CONCURRENT) % BATCH_SIZE === 0 || i + MAX_CONCURRENT >= limited.length) {
      console.log(`  [bitget_futures] ${Math.min(i + MAX_CONCURRENT, limited.length)}/${limited.length} (ok=${success} fail=${failed} skip=${skipped} filled=${filled})`)
    }

    if (i + MAX_CONCURRENT < limited.length) await sleep(BATCH_DELAY_MS)
  }

  return { platform: 'bitget_futures', field: 'roi_pct', success, failed, skipped, filled }
}

/**
 * bitfinex: ROI gap
 * Bitfinex ROI is estimated from PnL / equity proxy.
 * Re-fetch from rankings API: plu (equity), plu_diff (PnL change).
 * For traders with daily_snapshots, compute from first/last values.
 */
async function backfillBitfinexRoi(rows) {
  const uniqueTraders = uniqueTraderKeys(rows)
  const limited = LIMIT > 0 ? uniqueTraders.slice(0, LIMIT) : uniqueTraders

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[bitfinex] ROI backfill: ${rows.length} null rows, ${uniqueTraders.length} unique traders, processing ${limited.length}`)
  console.log(`${'='.repeat(60)}`)

  // Step 1: Fetch equity and PnL maps from Bitfinex API
  console.log('  Fetching Bitfinex rankings data...')
  const equityMap = new Map()
  const pnlMap = new Map()

  // Fetch equity proxy (plu = inception unrealized profit = equity proxy)
  try {
    const equityRows = await fetchWithTimeout(
      'https://api-pub.bitfinex.com/v2/rankings/plu:1M:tGLOBAL:USD/hist'
    )
    if (Array.isArray(equityRows)) {
      for (const row of equityRows) {
        if (Array.isArray(row) && row[2] && row[6] != null) {
          equityMap.set(String(row[2]).toLowerCase(), Number(row[6]))
        }
      }
    }
    console.log(`  Equity map: ${equityMap.size} entries`)
  } catch (e) {
    console.log(`  WARNING: Failed to fetch equity data: ${e.message}`)
  }

  // Fetch PnL diff for both 1w and 1M timeframes
  for (const tf of ['1w', '1M']) {
    try {
      const pnlRows = await fetchWithTimeout(
        `https://api-pub.bitfinex.com/v2/rankings/plu_diff:${tf}:tGLOBAL:USD/hist`
      )
      if (Array.isArray(pnlRows)) {
        for (const row of pnlRows) {
          if (Array.isArray(row) && row[2] && row[6] != null) {
            const key = `${String(row[2]).toLowerCase()}:${tf}`
            pnlMap.set(key, Number(row[6]))
          }
        }
      }
    } catch (e) {
      console.log(`  WARNING: Failed to fetch PnL data for ${tf}: ${e.message}`)
    }
  }
  console.log(`  PnL map: ${pnlMap.size} entries`)

  // Step 2: For each trader, compute ROI = PnL / equity * 100
  let success = 0, failed = 0, skipped = 0, filled = 0

  for (let i = 0; i < limited.length; i++) {
    const trader = limited[i]
    const traderId = trader.trader_key.toLowerCase()

    // Determine which timeframe to use based on window
    const traderRows = rows.filter(r => r.trader_key === trader.trader_key)

    for (const row of traderRows) {
      const tf = row.window === '7D' ? '1w' : '1M'
      const pnlKey = `${traderId}:${tf}`
      const pnl = pnlMap.get(pnlKey)
      const equity = equityMap.get(traderId)

      let roi = null
      if (equity != null && Math.abs(equity) > 1 && pnl != null && pnl !== 0) {
        roi = Math.max(-500, Math.min(50000, (pnl / Math.abs(equity)) * 100))
        roi = Math.round(roi * 100) / 100
      }

      // Fallback: try computing from daily_snapshots
      if (roi == null) {
        try {
          const { data: dailySnaps } = await supabase
            .from('trader_daily_snapshots')
            .select('date, roi')
            .eq('platform', 'bitfinex')
            .eq('trader_key', trader.trader_key)
            .order('date', { ascending: true })
            .limit(200)

          if (dailySnaps && dailySnaps.length >= 2) {
            const first = dailySnaps[0]
            const last = dailySnaps[dailySnaps.length - 1]
            if (first.roi != null && last.roi != null) {
              roi = Math.round((last.roi - first.roi) * 100) / 100
            }
          }
        } catch { /* ignore fallback errors */ }
      }

      if (roi == null) {
        skipped++
        continue
      }

      const updates = {}
      if (row.roi_pct == null) updates.roi_pct = roi
      if (row.pnl_usd == null && pnl != null) updates.pnl_usd = pnl

      if (Object.keys(updates).length > 0) {
        const ok = await updateSnapshot(row.id, updates)
        if (ok) filled++
      }
    }
    success++

    if ((i + 1) % BATCH_SIZE === 0 || i + 1 === limited.length) {
      console.log(`  [bitfinex] ${i + 1}/${limited.length} (ok=${success} skip=${skipped} filled=${filled})`)
    }
  }

  return { platform: 'bitfinex', field: 'roi_pct', success, failed, skipped, filled }
}

/**
 * okx_web3: ROI gap
 * Re-fetch from OKX API, compute ROI from pnlRatios cumulative daily series.
 * OKX Web3 API returns pnlRatios: Array<{ts, ratio}> — cumulative PnL ratio.
 */
async function backfillOkxWeb3Roi(rows) {
  const uniqueTraders = uniqueTraderKeys(rows)
  const limited = LIMIT > 0 ? uniqueTraders.slice(0, LIMIT) : uniqueTraders

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[okx_web3] ROI backfill: ${rows.length} null rows, ${uniqueTraders.length} unique traders, processing ${limited.length}`)
  console.log(`${'='.repeat(60)}`)

  let success = 0, failed = 0, skipped = 0, filled = 0

  for (let i = 0; i < limited.length; i += MAX_CONCURRENT) {
    const batch = limited.slice(i, i + MAX_CONCURRENT)

    const results = await Promise.allSettled(
      batch.map(async (trader) => {
        try {
          // OKX API: fetch lead trader details including pnlRatios
          const url = `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&uniqueCode=${trader.trader_key}`
          let data
          try {
            data = await fetchWithTimeout(url, {
              headers: { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' }
            })
          } catch {
            // OKX might be geo-blocked — try direct (no proxy needed per CLAUDE.md)
            return { trader_key: trader.trader_key, status: 'no_data' }
          }

          if (data?.code !== '0') return { trader_key: trader.trader_key, status: 'no_data' }

          // Handle both old (data[]) and new (data[0].ranks[]) format
          const traders = data.data?.[0]?.ranks ?? data.data ?? []
          const entry = traders.find(t => t.uniqueCode === trader.trader_key)
          if (!entry) return { trader_key: trader.trader_key, status: 'no_data' }

          // Compute ROI from pnlRatios
          const pnlRatios = entry.pnlRatios
          if (!Array.isArray(pnlRatios) || pnlRatios.length < 2) {
            // Fallback: use pnlRatio directly if available
            const directRoi = safeNum(entry.pnlRatio)
            if (directRoi != null) {
              return { trader_key: trader.trader_key, status: 'ok', roi: directRoi * 100 }
            }
            return { trader_key: trader.trader_key, status: 'no_data' }
          }

          // pnlRatios are cumulative — period ROI = last - first (as percentage)
          const sorted = [...pnlRatios].sort((a, b) => Number(a.ts) - Number(b.ts))
          const firstRatio = safeNum(sorted[0].ratio)
          const lastRatio = safeNum(sorted[sorted.length - 1].ratio)

          if (firstRatio == null || lastRatio == null) {
            return { trader_key: trader.trader_key, status: 'no_data' }
          }

          const roi = Math.round((lastRatio - firstRatio) * 100 * 100) / 100

          // Also extract PnL if available
          const pnl = safeNum(entry.pnl) ?? safeNum(entry.totalPnl) ?? safeNum(entry.accPnl)

          return { trader_key: trader.trader_key, status: 'ok', roi, pnl }
        } catch (e) {
          return { trader_key: trader.trader_key, status: 'error', error: e.message }
        }
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') { failed++; continue }
      const { trader_key, status, roi, pnl, error } = result.value

      if (status === 'error') {
        failed++
        if (failed <= 5) console.log(`  FAIL ${trader_key}: ${error}`)
        continue
      }
      if (status === 'no_data') { skipped++; continue }

      const traderRows = rows.filter(r => r.trader_key === trader_key)
      for (const row of traderRows) {
        const updates = {}
        if (row.roi_pct == null && roi != null) updates.roi_pct = roi
        if (row.pnl_usd == null && pnl != null) updates.pnl_usd = pnl
        if (Object.keys(updates).length > 0) {
          const ok = await updateSnapshot(row.id, updates)
          if (ok) filled++
        }
      }
      success++
    }

    if ((i + MAX_CONCURRENT) % BATCH_SIZE === 0 || i + MAX_CONCURRENT >= limited.length) {
      console.log(`  [okx_web3] ${Math.min(i + MAX_CONCURRENT, limited.length)}/${limited.length} (ok=${success} fail=${failed} skip=${skipped} filled=${filled})`)
    }

    if (i + MAX_CONCURRENT < limited.length) await sleep(BATCH_DELAY_MS)
  }

  return { platform: 'okx_web3', field: 'roi_pct', success, failed, skipped, filled }
}

/**
 * gains: ROI gap
 * Try multiple sources:
 * 1. Gains Network REST API /leaderboard (has pnl and pnlPercent per trader)
 * 2. Copin API for gTrade stats
 * 3. Daily snapshots fallback
 */
async function backfillGainsRoi(rows) {
  const uniqueTraders = uniqueTraderKeys(rows)
  const limited = LIMIT > 0 ? uniqueTraders.slice(0, LIMIT) : uniqueTraders

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[gains] ROI backfill: ${rows.length} null rows, ${uniqueTraders.length} unique traders, processing ${limited.length}`)
  console.log(`${'='.repeat(60)}`)

  // Pre-fetch leaderboard data from all chains to build a lookup map
  console.log('  Fetching Gains leaderboard data...')
  const leaderboardMap = new Map()
  const chains = ['arbitrum', 'polygon', 'base']

  for (const chain of chains) {
    try {
      const data = await fetchWithTimeout(
        `https://backend-${chain}.gains.trade/leaderboard`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          }
        },
        20000
      )

      if (Array.isArray(data)) {
        for (const entry of data) {
          const address = String(entry.address || entry.trader || '').toLowerCase()
          if (address && !leaderboardMap.has(address)) {
            leaderboardMap.set(address, entry)
          }
        }
        console.log(`  ${chain}: ${data.length} traders`)
      }
    } catch (e) {
      console.log(`  WARNING: Failed to fetch ${chain} leaderboard: ${e.message}`)
    }
  }
  console.log(`  Leaderboard map: ${leaderboardMap.size} entries`)

  let success = 0, failed = 0, skipped = 0, filled = 0

  for (let i = 0; i < limited.length; i += MAX_CONCURRENT) {
    const batch = limited.slice(i, i + MAX_CONCURRENT)

    const results = await Promise.allSettled(
      batch.map(async (trader) => {
        const traderId = trader.trader_key.toLowerCase()

        // Source 1: Gains leaderboard API data
        const lbEntry = leaderboardMap.get(traderId)
        if (lbEntry) {
          const roi = safeNum(lbEntry.pnlPercent) ?? safeNum(lbEntry.pnlPercentage) ?? safeNum(lbEntry.roi)
          const pnl = safeNum(lbEntry.pnl) ?? safeNum(lbEntry.totalPnl)
          if (roi != null || pnl != null) {
            return { trader_key: trader.trader_key, status: 'ok', roi, pnl }
          }
        }

        // Source 2: Copin API
        try {
          const copinData = await fetchWithTimeout(
            `https://api.copin.io/gains_arb/position/statistic/filter?accounts=${traderId}`,
            {},
            10000
          )
          if (copinData?.data?.[0]) {
            const d = copinData.data[0]
            const pnl = safeNum(d.realisedPnl) ?? safeNum(d.pnl)
            // Copin may provide ROI as percentage
            const roi = safeNum(d.roi) ?? safeNum(d.pnlPercent)
            if (roi != null || pnl != null) {
              return { trader_key: trader.trader_key, status: 'ok', roi, pnl }
            }
          }
        } catch { /* fallback to daily snapshots */ }

        // Source 3: Daily snapshots fallback
        try {
          const { data: dailySnaps } = await supabase
            .from('trader_daily_snapshots')
            .select('date, roi, pnl')
            .eq('platform', 'gains')
            .eq('trader_key', traderId)
            .order('date', { ascending: true })
            .limit(200)

          if (dailySnaps && dailySnaps.length >= 2) {
            const first = dailySnaps[0]
            const last = dailySnaps[dailySnaps.length - 1]
            const roi = (first.roi != null && last.roi != null) ? Math.round((last.roi - first.roi) * 100) / 100 : null
            const pnl = last.pnl != null ? last.pnl : null
            if (roi != null || pnl != null) {
              return { trader_key: trader.trader_key, status: 'ok', roi, pnl }
            }
          }
        } catch { /* no fallback */ }

        return { trader_key: trader.trader_key, status: 'no_data' }
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') { failed++; continue }
      const { trader_key, status, roi, pnl } = result.value

      if (status === 'no_data') { skipped++; continue }

      const traderRows = rows.filter(r => r.trader_key === trader_key)
      for (const row of traderRows) {
        const updates = {}
        if (row.roi_pct == null && roi != null) updates.roi_pct = roi
        if (row.pnl_usd == null && pnl != null) updates.pnl_usd = pnl
        if (Object.keys(updates).length > 0) {
          const ok = await updateSnapshot(row.id, updates)
          if (ok) filled++
        }
      }
      success++
    }

    if ((i + MAX_CONCURRENT) % BATCH_SIZE === 0 || i + MAX_CONCURRENT >= limited.length) {
      console.log(`  [gains] ${Math.min(i + MAX_CONCURRENT, limited.length)}/${limited.length} (ok=${success} fail=${failed} skip=${skipped} filled=${filled})`)
    }

    if (i + MAX_CONCURRENT < limited.length) await sleep(BATCH_DELAY_MS)
  }

  return { platform: 'gains', field: 'roi_pct', success, failed, skipped, filled }
}

/**
 * bybit: PnL gap
 * Use VPS scraper endpoint /bybit/trader-detail which returns full trader data
 * including absolutePnl. The VPS scraper uses Playwright to bypass WAF.
 */
async function backfillBybitPnl(rows) {
  const uniqueTraders = uniqueTraderKeys(rows)
  const limited = LIMIT > 0 ? uniqueTraders.slice(0, LIMIT) : uniqueTraders

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[bybit] PnL backfill: ${rows.length} null rows, ${uniqueTraders.length} unique traders, processing ${limited.length}`)
  console.log(`${'='.repeat(60)}`)

  // Bybit VPS scraper is serial (Playwright), go slow — 1 at a time
  const BYBIT_CONCURRENT = 1
  const BYBIT_DELAY = 3000

  let success = 0, failed = 0, skipped = 0, filled = 0

  for (let i = 0; i < limited.length; i += BYBIT_CONCURRENT) {
    const batch = limited.slice(i, i + BYBIT_CONCURRENT)

    const results = await Promise.allSettled(
      batch.map(async (trader) => {
        try {
          const data = await fetchViaScraper(
            `/bybit/trader-detail?leaderMark=${trader.trader_key}`,
            20000
          )

          if (!data) return { trader_key: trader.trader_key, status: 'no_data' }

          // VPS scraper returns various formats — extract PnL
          const detail = data?.result || data?.data || data
          const pnl = safeNum(detail?.currentPnl)
            ?? safeNum(detail?.pnl)
            ?? safeNum(detail?.totalPnl)
            ?? safeNum(detail?.profitAndLoss)

          // Also try to get ROI if missing
          const roi = safeNum(detail?.roi)
            ?? safeNum(detail?.roiPercent)
            ?? safeNum(detail?.totalRoi)

          if (pnl == null && roi == null) return { trader_key: trader.trader_key, status: 'no_data' }

          return { trader_key: trader.trader_key, status: 'ok', pnl, roi }
        } catch (e) {
          return { trader_key: trader.trader_key, status: 'error', error: e.message }
        }
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') { failed++; continue }
      const { trader_key, status, pnl, roi, error } = result.value

      if (status === 'error') {
        failed++
        if (failed <= 5) console.log(`  FAIL ${trader_key}: ${error}`)
        continue
      }
      if (status === 'no_data') { skipped++; continue }

      const traderRows = rows.filter(r => r.trader_key === trader_key)
      for (const row of traderRows) {
        const updates = {}
        if (row.pnl_usd == null && pnl != null) updates.pnl_usd = pnl
        if (row.roi_pct == null && roi != null) updates.roi_pct = roi
        if (Object.keys(updates).length > 0) {
          const ok = await updateSnapshot(row.id, updates)
          if (ok) filled++
        }
      }
      success++
    }

    if ((i + BYBIT_CONCURRENT) % BATCH_SIZE === 0 || i + BYBIT_CONCURRENT >= limited.length) {
      console.log(`  [bybit] ${Math.min(i + BYBIT_CONCURRENT, limited.length)}/${limited.length} (ok=${success} fail=${failed} skip=${skipped} filled=${filled})`)
    }

    if (i + BYBIT_CONCURRENT < limited.length) await sleep(BYBIT_DELAY)
  }

  return { platform: 'bybit', field: 'pnl_usd', success, failed, skipped, filled }
}

// ============ Platform Registry ============

const PLATFORM_BACKFILLERS = {
  bitget_futures: {
    description: 'ROI gap (~14%) — re-fetch from Bitget detail API via CF proxy',
    nullFields: ['roi_pct'],
    run: backfillBitgetFuturesRoi,
  },
  bitfinex: {
    description: 'ROI gap (~24%) — compute from PnL/equity or daily snapshots',
    nullFields: ['roi_pct'],
    run: backfillBitfinexRoi,
  },
  okx_web3: {
    description: 'ROI gap — re-fetch from OKX API, compute from pnlRatios',
    nullFields: ['roi_pct'],
    run: backfillOkxWeb3Roi,
  },
  gains: {
    description: 'ROI gap (~20%) — re-fetch from Gains leaderboard + Copin',
    nullFields: ['roi_pct'],
    run: backfillGainsRoi,
  },
  bybit: {
    description: 'PnL gap (~29%) — fetch from VPS scraper /bybit/trader-detail',
    nullFields: ['pnl_usd'],
    run: backfillBybitPnl,
  },
  // bybit_spot is intentionally SKIPPED:
  // API only returns percentage-based metrics, no absolute PnL.
  // Cannot compute PnL without AUM data which is not available.
}

// ============ Main ============

async function main() {
  console.log('=== Data Gaps Backfill ===')
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  if (PLATFORM_FILTER) console.log(`Platform filter: ${PLATFORM_FILTER}`)
  if (WINDOW_FILTER) console.log(`Window filter: ${WINDOW_FILTER}`)
  if (LIMIT) console.log(`Limit per platform: ${LIMIT}`)
  console.log(`Batch size: ${BATCH_SIZE}, delay: ${BATCH_DELAY_MS}ms`)
  console.log('')

  // Print initial gap counts
  console.log('--- Initial data gap counts ---')
  const { count: totalRows } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true })
  const { count: nullRoi } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('roi_pct', null)
  const { count: nullPnl } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('pnl_usd', null)

  console.log(`Total rows: ${totalRows}`)
  console.log(`Null roi_pct: ${nullRoi} (${totalRows > 0 ? Math.round((1 - nullRoi / totalRows) * 100) : 0}% coverage)`)
  console.log(`Null pnl_usd: ${nullPnl} (${totalRows > 0 ? Math.round((1 - nullPnl / totalRows) * 100) : 0}% coverage)`)

  // Per-platform null counts
  console.log('\n--- Per-platform gap breakdown ---')
  for (const [platform, config] of Object.entries(PLATFORM_BACKFILLERS)) {
    if (PLATFORM_FILTER && platform !== PLATFORM_FILTER) continue

    for (const field of config.nullFields) {
      const { count } = await supabase
        .from('trader_snapshots_v2')
        .select('id', { count: 'exact', head: true })
        .eq('platform', platform)
        .is(field, null)

      const { count: platformTotal } = await supabase
        .from('trader_snapshots_v2')
        .select('id', { count: 'exact', head: true })
        .eq('platform', platform)

      const pct = platformTotal > 0 ? Math.round((count / platformTotal) * 100) : 0
      console.log(`  ${platform.padEnd(18)} ${field.padEnd(10)} ${String(count).padStart(5)} null / ${String(platformTotal).padStart(5)} total (${pct}% gap)`)
    }
  }

  // Run backfills
  const allResults = []
  const platforms = PLATFORM_FILTER
    ? [PLATFORM_FILTER].filter(p => p in PLATFORM_BACKFILLERS)
    : Object.keys(PLATFORM_BACKFILLERS)

  if (PLATFORM_FILTER && !PLATFORM_BACKFILLERS[PLATFORM_FILTER]) {
    console.error(`\nERROR: Unknown platform '${PLATFORM_FILTER}'. Available: ${Object.keys(PLATFORM_BACKFILLERS).join(', ')}`)
    if (PLATFORM_FILTER === 'bybit_spot') {
      console.error('NOTE: bybit_spot is intentionally skipped — API only returns %, no absolute PnL without AUM data.')
    }
    process.exit(1)
  }

  for (const platform of platforms) {
    const config = PLATFORM_BACKFILLERS[platform]
    console.log(`\n>>> ${platform}: ${config.description}`)

    // Fetch rows with null fields
    const rows = await getSnapshotsWithNulls(platform, config.nullFields)
    if (rows.length === 0) {
      console.log(`  No null rows found, skipping.`)
      allResults.push({ platform, field: config.nullFields.join(','), success: 0, failed: 0, skipped: 0, filled: 0 })
      continue
    }

    const result = await config.run(rows)
    allResults.push(result)
  }

  // Final report
  console.log('\n\n' + '='.repeat(60))
  console.log('=== FINAL REPORT ===')
  console.log('='.repeat(60))

  const { count: finalNullRoi } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('roi_pct', null)
  const { count: finalNullPnl } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('pnl_usd', null)

  console.log(`\nroi_pct: ${nullRoi} -> ${finalNullRoi} null (filled ${nullRoi - finalNullRoi})`)
  console.log(`pnl_usd: ${nullPnl} -> ${finalNullPnl} null (filled ${nullPnl - finalNullPnl})`)

  console.log(`\nCoverage after backfill:`)
  console.log(`  roi_pct: ${totalRows > 0 ? Math.round((1 - finalNullRoi / totalRows) * 100) : 0}%`)
  console.log(`  pnl_usd: ${totalRows > 0 ? Math.round((1 - finalNullPnl / totalRows) * 100) : 0}%`)

  console.log('\nPer-platform summary:')
  for (const r of allResults) {
    console.log(`  ${r.platform.padEnd(18)} [${r.field}] ok=${String(r.success).padStart(4)} fail=${String(r.failed).padStart(4)} skip=${String(r.skipped).padStart(4)} filled=${String(r.filled).padStart(5)}`)
  }

  console.log(`\nNote: bybit_spot is intentionally skipped (no absolute PnL in API).`)
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
