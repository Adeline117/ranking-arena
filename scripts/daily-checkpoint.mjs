#!/usr/bin/env node
/**
 * daily-checkpoint.mjs — Atomic Import + Enrich Daily Snapshot
 *
 * Root cause fix: stop the "import first, enrich later" gap.
 * This script fetches leaderboard data AND stats in the same API pass,
 * then writes them atomically. No trader is ever saved without its metrics.
 *
 * Runs once per day at UTC 00:00 via launchd.
 *
 * Sources covered (direct API, no browser):
 *   ✅  binance_futures  — copy-trade list API + detail API
 *   ✅  okx_futures      — public lead-traders API (WR + MDD in listing)
 *   ✅  gains            — multi-chain leaderboard/all (WR computed)
 *   ✅  hyperliquid      — leaderboard API (PnL+rank; WR/MDD via per-trader calls, batched)
 *
 * Sources skipped (reasons inline):
 *   ⏭  bybit            — WAF-protected, requires Puppeteer stealth
 *   ⏭  bingx            — Cloudflare SSR, no accessible API
 *   ⏭  bitget_futures   — v2 API requires ACCESS_KEY authentication
 *   ⏭  kucoin           — CF Turnstile blocks all automation
 *   ⏭  phemex           — CF-protected, minimal data pool
 *   ⏭  aevo             — requires wallet authentication
 *   ⏭  mexc             — requires Puppeteer
 *
 * DB writes per trader (atomic — all fields set before first INSERT):
 *   1. trader_sources        — upsert (source, source_trader_id), set last_seen_at
 *   2. leaderboard_ranks     — upsert (season_id, source, source_trader_id)
 *   3. trader_snapshots      — upsert (source, source_trader_id, snapshot_date)
 *
 * Usage:
 *   node scripts/daily-checkpoint.mjs
 *   node scripts/daily-checkpoint.mjs --source=binance_futures
 *   node scripts/daily-checkpoint.mjs --dry-run
 *   node scripts/daily-checkpoint.mjs --period=30D   (default)
 *
 * Log: /tmp/daily-checkpoint.log
 */

import { readFileSync, appendFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────
// Bootstrap: env + logging
// ─────────────────────────────────────────────

// Load .env.local relative to this script's project root
const PROJECT_ROOT = new URL('..', import.meta.url).pathname
try {
  for (const line of readFileSync(`${PROJECT_ROOT}/.env.local`, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s]+)\s*=\s*["']?(.+?)["']?\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch { /* .env.local not required if env vars already set */ }

const LOG_FILE = '/tmp/daily-checkpoint.log'
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG_FILE, line + '\n') } catch {}
}

// ─────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────

const DRY_RUN    = process.argv.includes('--dry-run')
const TARGET_SRC = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] ?? null
const PERIOD     = (process.argv.find(a => a.startsWith('--period='))?.split('=')[1] ?? '30D').toUpperCase()
const TODAY      = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

// ─────────────────────────────────────────────
// Supabase client
// ─────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), ...opts })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

/** Inline Arena Score v2 (mirrors lib/shared.mjs) */
function calcArenaScore(roi, pnl, mdd, winRate, period = PERIOD) {
  const PARAMS = {
    '7D':  { tanhCoeff: 0.08, roiExp: 1.8, mddThresh: 15,  wrCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExp: 1.6, mddThresh: 30,  wrCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExp: 1.6, mddThresh: 40,  wrCap: 70 },
  }
  const PNL_PARAMS = {
    '7D':  { base: 500,  coeff: 0.40 },
    '30D': { base: 2000, coeff: 0.35 },
    '90D': { base: 5000, coeff: 0.30 },
  }
  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const p = PARAMS[period] || PARAMS['30D']
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const wr = winRate != null ? (winRate <= 1 ? winRate * 100 : winRate) : null

  // Return score (0–70)
  const intensity = (365 / days) * (roi > -100 ? Math.log(1 + roi / 100) : 0)
  const r0 = Math.tanh(p.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(70 * Math.pow(r0, p.roiExp), 0, 70) : 0

  // PnL score (0–15)
  let pnlScore = 0
  if (pnl != null && pnl > 0) {
    const pp = PNL_PARAMS[period] || PNL_PARAMS['30D']
    const la = 1 + pnl / pp.base
    if (la > 0) pnlScore = clip(15 * Math.tanh(pp.coeff * Math.log(la)), 0, 15)
  }

  // Drawdown score (0–8)
  const drawdownScore = mdd != null
    ? clip(8 * clip(1 - Math.abs(mdd) / p.mddThresh, 0, 1), 0, 8)
    : 4

  // Stability / win-rate score (0–7)
  const stabilityScore = wr != null
    ? clip(7 * clip((wr - 45) / (p.wrCap - 45), 0, 1), 0, 7)
    : 3.5

  return Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100
}

// ─────────────────────────────────────────────
// DB: atomic upsert for one source
// ─────────────────────────────────────────────

/**
 * @typedef {Object} TraderRecord
 * @property {string}      id          - source_trader_id
 * @property {string|null} handle
 * @property {string|null} avatar
 * @property {number|null} roi         - percent (e.g. 25.5 = 25.5%)
 * @property {number|null} pnl         - USD
 * @property {number|null} win_rate    - percent (e.g. 60 = 60%)
 * @property {number|null} max_drawdown - percent (e.g. 10 = 10%)
 * @property {number|null} trades_count
 * @property {number|null} followers
 * @property {number}      rank
 */

/**
 * Write a full set of traders for one source atomically.
 * All three tables get written before we move to the next batch.
 *
 * @param {string}          source
 * @param {TraderRecord[]}  traders  - already enriched
 */
async function writeCheckpoint(source, traders) {
  if (traders.length === 0) { log(`  [${source}] No traders to write`); return }
  if (DRY_RUN) {
    log(`  [${source}] DRY-RUN — would write ${traders.length} traders`)
    return
  }

  const now   = new Date().toISOString()
  const BATCH = 100

  // 1. trader_sources
  let srcOk = 0, srcErr = 0
  for (let i = 0; i < traders.length; i += BATCH) {
    const batch = traders.slice(i, i + BATCH).map(t => ({
      source,
      source_trader_id: t.id,
      handle:      t.handle  || null,
      avatar_url:  t.avatar  || null,
      is_active:   true,
      last_seen_at: now,
    }))
    const { error } = await supabase
      .from('trader_sources')
      .upsert(batch, { onConflict: 'source,source_trader_id' })
    if (error) { srcErr += batch.length; log(`  [${source}] trader_sources err: ${error.message}`) }
    else srcOk += batch.length
    await sleep(100)
  }
  log(`  [${source}] trader_sources: ok=${srcOk} err=${srcErr}`)

  // 2. leaderboard_ranks (upsert on season_id, source, source_trader_id)
  let lrOk = 0, lrErr = 0
  for (let i = 0; i < traders.length; i += BATCH) {
    const batch = traders.slice(i, i + BATCH).map(t => ({
      source,
      source_trader_id: t.id,
      season_id:    PERIOD,
      rank:         t.rank,
      handle:       t.handle       || null,
      avatar_url:   t.avatar       || null,
      roi:          t.roi          ?? null,
      pnl:          t.pnl          ?? null,
      win_rate:     t.win_rate     ?? null,
      max_drawdown: t.max_drawdown ?? null,
      trades_count: t.trades_count ?? null,
      followers:    t.followers    ?? null,
      arena_score:  calcArenaScore(t.roi ?? 0, t.pnl, t.max_drawdown, t.win_rate),
      updated_at:   now,
    }))
    const { error } = await supabase
      .from('leaderboard_ranks')
      .upsert(batch, { onConflict: 'season_id,source,source_trader_id' })
    if (error) { lrErr += batch.length; log(`  [${source}] leaderboard_ranks err: ${error.message}`) }
    else lrOk += batch.length
    await sleep(100)
  }
  log(`  [${source}] leaderboard_ranks: ok=${lrOk} err=${lrErr}`)

  // 3. trader_snapshots with snapshot_date = TODAY
  let snOk = 0, snErr = 0
  for (let i = 0; i < traders.length; i += BATCH) {
    const batch = traders.slice(i, i + BATCH).map(t => ({
      source,
      source_trader_id: t.id,
      season_id:     PERIOD,
      snapshot_date: TODAY,
      captured_at:   now,
      rank:          t.rank,
      roi:           t.roi          ?? null,
      pnl:           t.pnl          ?? null,
      win_rate:      t.win_rate     ?? null,
      max_drawdown:  t.max_drawdown ?? null,
      trades_count:  t.trades_count ?? null,
      followers:     t.followers    ?? null,
      arena_score:   calcArenaScore(t.roi ?? 0, t.pnl, t.max_drawdown, t.win_rate),
    }))
    const { error } = await supabase
      .from('trader_snapshots')
      .upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
    if (error) { snErr += batch.length; log(`  [${source}] trader_snapshots err: ${error.message}`) }
    else snOk += batch.length
    await sleep(100)
  }
  log(`  [${source}] trader_snapshots: ok=${snOk} err=${snErr}`)
}

// ─────────────────────────────────────────────
// ── SOURCE: Binance Futures ──────────────────
// Copy-trade list API → detail API (ROI, PnL, WR, MDD all from detail)
// Falls back to CLOUDFLARE_PROXY_URL if direct fetch returns 451/403.
// ─────────────────────────────────────────────

const BNF_LIST_API   = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
const BNF_DETAIL_API = 'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance'
const BNF_CF_PROXY   = process.env.CLOUDFLARE_PROXY_URL || null   // e.g. https://my-worker.workers.dev
const BNF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Origin': 'https://www.binance.com',
  'Referer': 'https://www.binance.com/en/copy-trading',
}

/** Proxy-aware POST/GET for Binance (bypasses geo-451 via CF Worker) */
async function bnfFetch(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) })
    if (res.ok) return res
    if ((res.status === 451 || res.status === 403) && BNF_CF_PROXY) {
      log(`  binance: direct ${res.status}, retrying via proxy...`)
      return fetch(`${BNF_CF_PROXY}/proxy?url=${encodeURIComponent(url)}`, {
        ...opts, signal: AbortSignal.timeout(20000),
      })
    }
    return res
  } catch (e) {
    if (BNF_CF_PROXY) {
      return fetch(`${BNF_CF_PROXY}/proxy?url=${encodeURIComponent(url)}`, {
        ...opts, signal: AbortSignal.timeout(20000),
      })
    }
    throw e
  }
}

async function fetchBinanceFutures() {
  log('\n══ binance_futures — fetching list...')
  if (!BNF_CF_PROXY) log('  Note: CLOUDFLARE_PROXY_URL not set — may fail on geo-blocked IPs')
  const portfolioIds = new Map() // portfolioId → basic info
  const PAGE_SIZE = 20
  const TARGET = 500

  for (let page = 1; portfolioIds.size < TARGET && page <= 30; page++) {
    try {
      const res = await bnfFetch(BNF_LIST_API, {
        method: 'POST',
        headers: BNF_HEADERS,
        body: JSON.stringify({
          pageNumber: page,
          pageSize:   PAGE_SIZE,
          timeRange:  PERIOD === '7D' ? 'WEEKLY' : PERIOD === '90D' ? 'QUARTERLY' : 'MONTHLY',
          dataType:   'ROI',
          order:      'DESC',
        }),
      })
      if (!res.ok) {
        log(`  binance_futures page ${page}: HTTP ${res.status}`)
        await sleep(1000)
        continue
      }
      const json = await res.json()
      if (json.code !== '000000' || !json.data?.list) {
        log(`  binance_futures page ${page}: code=${json.code}`)
        break
      }
      for (const item of json.data.list) {
        const pid = String(item.leadPortfolioId || item.portfolioId || item.encryptedUid || '')
        if (!pid || portfolioIds.has(pid)) continue
        const roi = parseFloat(item.roi ?? 0)
        if (Math.abs(roi) > 50000) continue  // skip anomalous
        portfolioIds.set(pid, {
          nickname: item.nickName || null,
          avatar:   item.userPhoto || null,
          roi,
          pnl:       parseFloat(item.pnl ?? 0),
          winRate:   parseFloat(item.winRate ?? 0),
          mdd:       parseFloat(item.mdd ?? 0),
          followers: parseInt(item.copierCount ?? 0),
        })
      }
      log(`  page ${page}: ${json.data.list.length} items, total=${portfolioIds.size}`)
      await sleep(300)
    } catch (e) {
      log(`  binance_futures list page ${page} error: ${e.message}`)
      await sleep(1000)
    }
  }

  log(`  Fetched ${portfolioIds.size} traders from list. Now fetching details...`)

  // Concurrently fetch detail (WR, MDD, trades from detail API)
  const CONCURRENCY = 8
  const ids    = [...portfolioIds.keys()]
  const traders = []
  const queue  = ids.map((pid, idx) => ({ pid, idx }))

  async function fetchDetailWorker(items) {
    for (const { pid, idx } of items) {
      try {
        const timeRange = PERIOD === '7D' ? 'WEEKLY' : PERIOD === '90D' ? 'QUARTERLY' : 'MONTHLY'
        const url = `${BNF_DETAIL_API}?portfolioId=${pid}&timeRange=${timeRange}`
        const detailRes = await bnfFetch(url, { headers: BNF_HEADERS })
        const json = detailRes.ok ? await detailRes.json() : null
        const d = json?.data
        const base = portfolioIds.get(pid)
        traders.push({
          id:           pid,
          rank:         idx + 1,
          handle:       base.nickname,
          avatar:       base.avatar,
          roi:          d?.roi     != null ? parseFloat(d.roi) * 100 : base.roi,
          pnl:          d?.pnl     != null ? parseFloat(d.pnl)       : base.pnl,
          win_rate:     d?.winRate != null ? parseFloat(d.winRate) * 100 : (base.winRate > 1 ? base.winRate : base.winRate * 100),
          max_drawdown: d?.mdd     != null ? parseFloat(d.mdd) * 100 : base.mdd,
          trades_count: d?.totalOrder != null ? parseInt(d.totalOrder) : null,
          followers:    base.followers,
        })
      } catch {
        // fallback to list data (no detail available)
        const base = portfolioIds.get(pid)
        traders.push({
          id:           pid,
          rank:         ids.indexOf(pid) + 1,
          handle:       base.nickname,
          avatar:       base.avatar,
          roi:          base.roi,
          pnl:          base.pnl,
          win_rate:     base.winRate > 1 ? base.winRate : base.winRate * 100,
          max_drawdown: base.mdd,
          trades_count: null,
          followers:    base.followers,
        })
      }
      await sleep(150)
    }
  }

  // Split into CONCURRENCY workers
  const chunkSize = Math.ceil(queue.length / CONCURRENCY)
  const chunks    = []
  for (let i = 0; i < queue.length; i += chunkSize) chunks.push(queue.slice(i, i + chunkSize))
  await Promise.all(chunks.map(fetchDetailWorker))

  // Sort by roi desc, re-assign rank
  traders.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity))
  traders.forEach((t, i) => { t.rank = i + 1 })

  log(`  binance_futures: ${traders.length} traders fully enriched`)
  return traders
}

// ─────────────────────────────────────────────
// ── SOURCE: OKX Futures ──────────────────────
// Public lead-traders API — WR and MDD both in the listing (no extra call)
// ─────────────────────────────────────────────

const OKX_API = 'https://www.okx.com/api/v5/copytrading/public-lead-traders'

/** Compute period ROI and MDD from OKX pnlRatios[] array */
function computeOkxMetrics(pnlRatios, period) {
  if (!Array.isArray(pnlRatios) || pnlRatios.length < 2) return { roi: null, maxDrawdown: null }
  const DAYS = { '7D': 7, '30D': 30, '90D': 90 }
  const days = DAYS[period] || 30
  const sorted = [...pnlRatios].sort((a, b) => +a.beginTs - +b.beginTs)
  const slice  = sorted.slice(-days)
  if (slice.length < 2) return { roi: null, maxDrawdown: null }

  const firstR = parseFloat(slice[0].pnlRatio)
  const lastR  = parseFloat(slice[slice.length - 1].pnlRatio)
  const roi    = ((1 + lastR) / (1 + firstR) - 1) * 100

  const equity = slice.map(r => 1 + parseFloat(r.pnlRatio))
  let peak = equity[0], maxDD = 0
  for (const eq of equity) {
    if (eq > peak) peak = eq
    if (peak > 0) { const dd = ((peak - eq) / peak) * 100; if (dd > maxDD) maxDD = dd }
  }
  return {
    roi:         isFinite(roi) ? roi : null,
    maxDrawdown: maxDD > 0.01 && maxDD < 100 ? maxDD : null,
  }
}

async function fetchOkxFutures() {
  log('\n══ okx_futures — fetching pages...')
  const traders = []
  let totalPages = 1

  for (let page = 1; page <= Math.min(totalPages, 60); page++) {
    try {
      const json = await fetchJSON(`${OKX_API}?instType=SWAP&page=${page}`, {
        headers: { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      })
      if (json.code !== '0' || !json.data?.length) {
        log(`  okx_futures page ${page}: code=${json.code}`)
        break
      }
      const item = json.data[0]
      if (page === 1) {
        totalPages = parseInt(item.totalPage) || 1
        log(`  okx_futures: ${totalPages} pages (~${totalPages * 10} traders)`)
      }
      for (const t of item.ranks || []) {
        const metrics = computeOkxMetrics(t.pnlRatios, PERIOD)
        const globalRoi = parseFloat(t.pnlRatio ?? 0) * 100
        traders.push({
          id:           t.uniqueCode,
          rank:         traders.length + 1,
          handle:       t.nickName || null,
          avatar:       t.portLink || null,
          roi:          metrics.roi      ?? globalRoi,
          pnl:          parseFloat(t.pnl ?? 0),
          win_rate:     t.winRatio != null ? parseFloat(t.winRatio) * 100 : null,
          max_drawdown: metrics.maxDrawdown,
          trades_count: null,
          followers:    parseInt(t.copyTraderNum ?? 0),
        })
      }
      log(`  page ${page}/${totalPages}: +${(item.ranks || []).length}, total=${traders.length}`)
      await sleep(500)
    } catch (e) {
      log(`  okx_futures page ${page} error: ${e.message}`)
      await sleep(1000)
    }
  }

  traders.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity))
  traders.forEach((t, i) => { t.rank = i + 1 })
  log(`  okx_futures: ${traders.length} traders with WR + MDD from listing`)
  return traders
}

// ─────────────────────────────────────────────
// ── SOURCE: Gains (gTrade) ───────────────────
// Multi-chain leaderboard/all → WR computed from wins/losses
// ─────────────────────────────────────────────

const GAINS_CHAINS = [
  { name: 'arbitrum', base: 'https://backend-arbitrum.gains.trade' },
  { name: 'polygon',  base: 'https://backend-polygon.gains.trade'  },
  { name: 'base',     base: 'https://backend-base.gains.trade'     },
]
// Map our PERIOD → gains period key inside /leaderboard/all response
const GAINS_KEY_MAP = { '7D': '7', '30D': '30', '90D': '90' }

async function fetchGains() {
  log('\n══ gains — fetching multi-chain leaderboard/all...')
  const byAddress = new Map() // address → best entry

  for (const chain of GAINS_CHAINS) {
    try {
      const data = await fetchJSON(`${chain.base}/leaderboard/all`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      })
      if (!data || typeof data !== 'object') { log(`  gains/${chain.name}: empty response`); continue }

      const periodKey = GAINS_KEY_MAP[PERIOD] || '30'
      const list      = data[periodKey] || data['30'] || data['7'] || []
      log(`  gains/${chain.name}: ${list.length} traders (period=${periodKey})`)

      for (const t of list) {
        const addr = (t.address || '').toLowerCase()
        if (!addr) continue
        const pnl    = parseFloat(t.total_pnl_usd || t.total_pnl || 0)
        const wins   = parseInt(t.count_win  || 0)
        const losses = parseInt(t.count_loss || 0)
        const trades = parseInt(t.count || 0)
        const existing = byAddress.get(addr)
        if (!existing || Math.abs(pnl) > Math.abs(existing.pnl)) {
          byAddress.set(addr, { addr, pnl, wins, losses, trades, chain: chain.name })
        }
      }
    } catch (e) {
      log(`  gains/${chain.name} error: ${e.message}`)
    }
    await sleep(300)
  }

  const traders = [...byAddress.values()]
    .sort((a, b) => b.pnl - a.pnl)
    .map((t, i) => {
      const winRate = t.trades > 0 ? (t.wins / t.trades) * 100 : null
      // Rough ROI estimate (Gains doesn't expose account equity directly)
      const avgPos   = t.trades > 0 ? Math.abs(t.pnl) / t.trades : 0
      const capital  = avgPos > 0 ? avgPos * t.trades : Math.abs(t.pnl)
      const roi      = capital > 0 ? (t.pnl / capital) * 100 : 0
      return {
        id:           t.addr,
        rank:         i + 1,
        handle:       null,
        avatar:       null,
        roi,
        pnl:          t.pnl,
        win_rate:     winRate,
        max_drawdown: null,    // Gains API doesn't expose MDD in bulk listing
        trades_count: t.trades,
        followers:    null,
      }
    })

  log(`  gains: ${traders.length} traders (WR computed; MDD not available from bulk API)`)
  return traders
}

// ─────────────────────────────────────────────
// ── SOURCE: Hyperliquid ──────────────────────
// Leaderboard → per-trader fills (WR) + portfolio (MDD)
// Rate-limit: ~1 req/2s → we cap to top-200 for daily checkpoint speed
// ─────────────────────────────────────────────

const HL_API = 'https://api.hyperliquid.xyz/info'
const HL_PORTFOLIO_KEY = { '7D': 'perpWeek', '30D': 'perpMonth', '90D': 'perpAllTime' }

async function hlPost(body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      })
      if (res.status === 200) return res.json()
      if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue }
      return null
    } catch (e) {
      if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue }
      return null
    }
  }
  return null
}

async function fetchHyperliquid() {
  log('\n══ hyperliquid — fetching leaderboard...')

  const lb = await hlPost({ type: 'leaderboard' })
  if (!lb?.leaderboardRows) { log('  hyperliquid: leaderboard empty'); return [] }

  const rows = lb.leaderboardRows
  log(`  hyperliquid: ${rows.length} traders in leaderboard`)

  // Extract PnL per window from leaderboardRows
  // windowPerformances = [[windowName, {pnl, roi, vlm}], ...]
  const WINDOW_IDX = { '7D': 0, '30D': 1, '90D': 2 }
  const wIdx = WINDOW_IDX[PERIOD] ?? 1

  const baseTraders = rows
    .map(r => {
      const perf = r.windowPerformances?.[wIdx]?.[1]
      return {
        addr: (r.ethAddress || '').toLowerCase(),
        pnl:  perf?.pnl  != null ? parseFloat(perf.pnl)  : null,
        roi:  perf?.roi   != null ? parseFloat(perf.roi) * 100 : null,  // HL roi is decimal
        vlm:  perf?.vlm  != null ? parseFloat(perf.vlm)  : null,
      }
    })
    .filter(r => r.addr)
    .sort((a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity))

  // Enrich top 200 traders with WR (userFills) + MDD (portfolio)
  // Beyond 200, write PnL/rank only (WR/MDD stay null for now)
  const ENRICH_LIMIT = 200
  const toEnrich     = baseTraders.slice(0, ENRICH_LIMIT)
  log(`  Enriching top ${toEnrich.length} traders for WR + MDD (rate-limited)...`)

  const enriched = []
  for (const t of toEnrich) {
    let winRate = null, maxDrawdown = null

    // WR from fills
    try {
      const fills = await hlPost({ type: 'userFills', user: t.addr })
      if (Array.isArray(fills) && fills.length > 0) {
        const DAYS  = { '7D': 7, '30D': 30, '90D': 90 }
        const days  = DAYS[PERIOD] || 30
        const cutoff = Date.now() - days * 24 * 3600 * 1000
        const closed = fills.filter(f => f.time >= cutoff && parseFloat(f.closedPnl || 0) !== 0)
        if (closed.length >= 3) {
          const wins = closed.filter(f => parseFloat(f.closedPnl) > 0).length
          winRate = (wins / closed.length) * 100
        }
      }
    } catch {}
    await sleep(600)   // HL rate limit

    // MDD from portfolio
    try {
      const pKey = HL_PORTFOLIO_KEY[PERIOD] || 'perpMonth'
      const portfolio = await hlPost({ type: 'portfolio', user: t.addr })
      if (Array.isArray(portfolio)) {
        const periodData = portfolio.find(([k]) => k === pKey)?.[1]
        if (periodData?.pnlHistory?.length) {
          const avh = periodData.accountValueHistory || []
          const ph  = periodData.pnlHistory
          let mdd = 0
          for (let i = 0; i < ph.length; i++) {
            const startAV  = parseFloat(avh[i]?.[1] || 0)
            const startPnl = parseFloat(ph[i][1])
            if (startAV <= 0) continue
            for (let j = i + 1; j < ph.length; j++) {
              const dd = (parseFloat(ph[j][1]) - startPnl) / startAV
              if (dd < mdd) mdd = dd
            }
          }
          if (Math.abs(mdd) > 0.001) maxDrawdown = Math.abs(mdd) * 100
        }
      }
    } catch {}
    await sleep(600)   // HL rate limit

    enriched.push({ ...t, win_rate: winRate, max_drawdown: maxDrawdown })
  }

  // Remainder — no WR/MDD (faster)
  const remainder = baseTraders.slice(ENRICH_LIMIT).map(t => ({
    ...t, win_rate: null, max_drawdown: null,
  }))

  const traders = [...enriched, ...remainder].map((t, i) => ({
    id:           t.addr,
    rank:         i + 1,
    handle:       null,
    avatar:       null,
    roi:          t.roi,
    pnl:          t.pnl,
    win_rate:     t.win_rate,
    max_drawdown: t.max_drawdown,
    trades_count: null,
    followers:    null,
  }))

  log(`  hyperliquid: ${traders.length} traders (${toEnrich.length} fully enriched)`)
  return traders
}

// ─────────────────────────────────────────────
// Staleness: flag traders not seen today
// ─────────────────────────────────────────────

/**
 * Mark traders active today vs stale (30+ days unseen).
 * We simply update last_seen_at for traders we JUST wrote.
 * The leaderboard_ranks already gets updated in writeCheckpoint.
 * This function logs the count of stale traders per source.
 */
async function logStaleTraders(source, activeIds) {
  if (DRY_RUN || activeIds.length === 0) return

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const { count } = await supabase
    .from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .eq('source', source)
    .lt('last_seen_at', thirtyDaysAgo)

  if (count > 0) {
    log(`  [${source}] ⚠ ${count} traders not seen in 30+ days (stale)`)
  }
}

// ─────────────────────────────────────────────
// Source registry
// ─────────────────────────────────────────────

const SOURCES = {
  binance_futures: fetchBinanceFutures,
  okx_futures:     fetchOkxFutures,
  gains:           fetchGains,
  hyperliquid:     fetchHyperliquid,
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  log('═'.repeat(64))
  log(`Arena Daily Checkpoint — ${TODAY}  [period=${PERIOD}]`)
  log(DRY_RUN ? 'Mode: DRY-RUN (no writes)' : 'Mode: LIVE')
  log('═'.repeat(64))

  const toRun = TARGET_SRC
    ? [TARGET_SRC]
    : Object.keys(SOURCES)

  log(`\nSources: ${toRun.join(', ')}`)
  log(`Skipped (need browser/auth): bybit, bingx, bitget_futures, kucoin, phemex, aevo, mexc\n`)

  const t0 = Date.now()
  const summary = []

  for (const src of toRun) {
    const fetcher = SOURCES[src]
    if (!fetcher) { log(`[${src}] No fetcher registered — skipping`); continue }

    const t1 = Date.now()
    try {
      const traders = await fetcher()
      await writeCheckpoint(src, traders)
      await logStaleTraders(src, traders.map(t => t.id))
      const elapsed = ((Date.now() - t1) / 1000).toFixed(1)
      summary.push({ src, count: traders.length, elapsed, status: '✅' })
      log(`  [${src}] done in ${elapsed}s — ${traders.length} traders`)
    } catch (e) {
      const elapsed = ((Date.now() - t1) / 1000).toFixed(1)
      log(`  [${src}] ❌ FATAL: ${e.message} (${elapsed}s)`)
      summary.push({ src, count: 0, elapsed, status: '❌' })
    }

    // Pause between sources to be polite to APIs
    await sleep(1000)
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1)
  log('\n' + '═'.repeat(64))
  log(`Checkpoint complete — ${total}s total`)
  for (const s of summary) {
    log(`  ${s.status} ${s.src.padEnd(20)} ${String(s.count).padStart(5)} traders  ${s.elapsed}s`)
  }
  log('═'.repeat(64))
}

main().catch(e => {
  log(`FATAL: ${e.message}\n${e.stack}`)
  process.exit(1)
})
