#!/usr/bin/env node
/**
 * Backfill REAL metrics (win_rate, max_drawdown, sharpe_ratio) from each exchange's API.
 *
 * Goes platform-by-platform, fetches REAL data from exchange APIs,
 * and updates trader_snapshots_v2 WHERE the specific field IS NULL.
 *
 * Usage: node scripts/backfill-real-data.mjs [--platform=xxx] [--limit=N] [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const VPS_PROXY_SG = process.env.VPS_PROXY_SG || 'http://45.76.152.169:3456'
const VPS_SCRAPER_SG = process.env.VPS_SCRAPER_SG || process.env.VPS_SCRAPER_HOST || 'http://45.76.152.169:3457'
const VPS_PROXY_KEY = process.env.VPS_PROXY_KEY || 'arena-proxy-sg-2026'
const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const DELAY_MS = 200
const MAX_CONCURRENT = 3
const TIMEOUT_MS = 10000
const DRY_RUN = process.argv.includes('--dry-run')
const PLATFORM_FILTER = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1] || null
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0

// ============ Helpers ============

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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

async function fetchViaProxy(targetUrl, timeoutMs = TIMEOUT_MS) {
  // Try direct first, then VPS proxy
  try {
    return await fetchWithTimeout(targetUrl, {}, timeoutMs)
  } catch {
    // Fallback: VPS proxy
    const proxyUrl = `${VPS_PROXY_SG}?url=${encodeURIComponent(targetUrl)}`
    return await fetchWithTimeout(proxyUrl, {
      headers: { 'x-proxy-key': VPS_PROXY_KEY }
    }, timeoutMs)
  }
}

async function fetchViaCFProxy(targetUrl, timeoutMs = TIMEOUT_MS) {
  const proxyUrl = `${CF_PROXY}?url=${encodeURIComponent(targetUrl)}`
  return await fetchWithTimeout(proxyUrl, {}, timeoutMs)
}

async function fetchViaScraper(path, timeoutMs = TIMEOUT_MS) {
  return await fetchWithTimeout(`${VPS_SCRAPER_SG}${path}`, {
    headers: { 'x-proxy-key': VPS_PROXY_KEY }
  }, timeoutMs)
}

/** Get all trader_keys with null metrics for a platform */
async function getTradersWithNulls(platform, fields = ['win_rate', 'max_drawdown', 'sharpe_ratio']) {
  const PAGE = 1000
  const results = []
  let offset = 0

  // Build OR filter for any null field
  const orFilter = fields.map(f => `${f}.is.null`).join(',')

  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('id, platform, trader_key, window, win_rate, max_drawdown, sharpe_ratio')
      .eq('platform', platform)
      .or(orFilter)
      .range(offset, offset + PAGE - 1)

    if (error) { console.error(`  DB error: ${error.message}`); break }
    if (!data || data.length === 0) break
    results.push(...data)
    if (data.length < PAGE) break
    offset += PAGE
  }

  return results
}

/** Update a single snapshot row with non-null metrics */
async function updateMetrics(id, updates) {
  if (DRY_RUN) return true
  const { error } = await supabase
    .from('trader_snapshots_v2')
    .update(updates)
    .eq('id', id)
  return !error
}

/** Deduplicate traders — same trader_key may appear in multiple windows */
function uniqueTraderKeys(rows) {
  const seen = new Set()
  return rows.filter(r => {
    if (seen.has(r.trader_key)) return false
    seen.add(r.trader_key)
    return true
  })
}

/** Run backfill for a platform with concurrency control */
async function backfillPlatform(platform, fetchDetailFn, rows) {
  const uniqueTraders = uniqueTraderKeys(rows)
  const limited = LIMIT > 0 ? uniqueTraders.slice(0, LIMIT) : uniqueTraders

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[${platform}] ${rows.length} null rows, ${uniqueTraders.length} unique traders, processing ${limited.length}`)
  console.log(`${'='.repeat(60)}`)

  let success = 0, failed = 0, skipped = 0
  const stats = { win_rate_filled: 0, max_drawdown_filled: 0, sharpe_ratio_filled: 0 }

  for (let i = 0; i < limited.length; i += MAX_CONCURRENT) {
    const batch = limited.slice(i, i + MAX_CONCURRENT)

    const results = await Promise.allSettled(
      batch.map(async (trader) => {
        try {
          const detail = await fetchDetailFn(trader.trader_key)
          if (!detail) return { trader_key: trader.trader_key, status: 'no_data' }
          return { trader_key: trader.trader_key, status: 'ok', detail }
        } catch (e) {
          return { trader_key: trader.trader_key, status: 'error', error: e.message || String(e) }
        }
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        failed++
        continue
      }

      const { trader_key, status, detail, error } = result.value

      if (status === 'error') {
        failed++
        if (failed <= 5) console.log(`  FAIL ${trader_key}: ${error}`)
        continue
      }

      if (status === 'no_data' || !detail) {
        skipped++
        continue
      }

      // Find all snapshot rows for this trader_key and update null fields
      const traderRows = rows.filter(r => r.trader_key === trader_key)
      for (const row of traderRows) {
        const updates = {}

        if (row.win_rate == null && detail.win_rate != null) {
          updates.win_rate = detail.win_rate
          stats.win_rate_filled++
        }
        if (row.max_drawdown == null && detail.max_drawdown != null) {
          updates.max_drawdown = detail.max_drawdown
          stats.max_drawdown_filled++
        }
        if (row.sharpe_ratio == null && detail.sharpe_ratio != null) {
          updates.sharpe_ratio = detail.sharpe_ratio
          stats.sharpe_ratio_filled++
        }

        if (Object.keys(updates).length > 0) {
          await updateMetrics(row.id, updates)
        }
      }

      success++
    }

    // Progress
    if ((i + MAX_CONCURRENT) % 30 === 0 || i + MAX_CONCURRENT >= limited.length) {
      console.log(`  [${platform}] ${i + batch.length}/${limited.length} (ok=${success} fail=${failed} skip=${skipped})`)
    }

    if (i + MAX_CONCURRENT < limited.length) await sleep(DELAY_MS)
  }

  console.log(`  [${platform}] DONE: ${success} ok, ${failed} failed, ${skipped} skipped`)
  console.log(`  Filled: win_rate=${stats.win_rate_filled}, max_drawdown=${stats.max_drawdown_filled}, sharpe_ratio=${stats.sharpe_ratio_filled}`)

  return { platform, success, failed, skipped, stats }
}

// ============ Platform-specific fetchers ============
// Each returns { win_rate, max_drawdown, sharpe_ratio } or null

async function fetchBinanceFuturesDetail(traderId) {
  const url = `https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${traderId}&timeRange=90D`
  const data = await fetchViaProxy(url)
  if (!data?.data) return null
  const d = data.data
  return {
    win_rate: d.winRate ?? null,
    max_drawdown: d.mdd ?? null,
    sharpe_ratio: d.sharpRatio ?? null,
  }
}

async function fetchBinanceSpotDetail(traderId) {
  const url = `https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${traderId}&timeRange=90D`
  const data = await fetchViaProxy(url)
  if (!data?.data) return null
  const d = data.data
  return {
    win_rate: d.winRate ?? null,
    max_drawdown: d.mdd ?? null,
    sharpe_ratio: d.sharpRatio ?? null,
  }
}

async function fetchOkxDetail(traderId) {
  const url = `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&uniqueCode=${traderId}`
  const data = await fetchWithTimeout(url, {
    headers: { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' }
  })
  if (data?.code !== '0' || !data?.data?.length) return null
  const d = data.data[0]
  const parseNum = (v) => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n }
  const winRate = parseNum(d.winRatio)
  const mdd = parseNum(d.mdd)
  const sharpe = parseNum(d.sharpeRatio)
  return {
    win_rate: winRate != null ? winRate * 100 : null,
    max_drawdown: mdd,
    sharpe_ratio: sharpe,
  }
}

async function fetchBitgetDetail(traderId) {
  const targetUrl = `https://www.bitget.com/v1/trigger/trace/public/trader/detail?traderId=${traderId}`
  const data = await fetchViaCFProxy(targetUrl)
  if (!data?.data) return null
  const d = data.data
  const parseNum = (v) => { if (v == null) return null; const n = typeof v === 'string' ? parseFloat(v) : Number(v); return isNaN(n) ? null : n }
  return {
    win_rate: parseNum(d.winRate),
    max_drawdown: parseNum(d.maxDrawdown),
    sharpe_ratio: parseNum(d.sharpeRatio),
  }
}

async function fetchMexcDetail(traderId) {
  const url = `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/detail?uid=${traderId}`
  const data = await fetchViaProxy(url)
  if (data?.code !== 0 || !data?.data) return null
  const d = data.data
  return {
    win_rate: d.winRate != null ? Number(d.winRate) * 100 : null,
    max_drawdown: d.maxRetrace != null ? Number(d.maxRetrace) * 100 : null,
    sharpe_ratio: null, // MEXC doesn't provide sharpe
  }
}

async function fetchHtxDetail(traderId) {
  const url = `https://www.htx.com/openapi/copy-trade/v1/public/trade/detail?uid=${traderId}`
  const data = await fetchWithTimeout(url)
  if (!data?.data) return null
  const d = data.data
  return {
    win_rate: d.winRate != null ? Number(d.winRate) * 100 : null,
    max_drawdown: d.mdd != null ? Number(d.mdd) * 100 : null,
    sharpe_ratio: null,
  }
}

async function fetchGateioDetail(traderId) {
  const url = `https://www.gate.io/api/copytrade/copyTrading/trader/homeDetail/${traderId}`
  const data = await fetchWithTimeout(url)
  if (!data?.data) return null
  const d = data.data
  return {
    win_rate: d.winRate != null ? Number(d.winRate) * 100 : null,
    max_drawdown: d.mdd != null ? Number(d.mdd) * 100 : null,
    sharpe_ratio: null,
  }
}

async function fetchDydxDetail(traderId) {
  // Use Copin API for dYdX stats
  const url = `https://api.copin.io/dydx/position/statistic/filter?accounts=${traderId}`
  try {
    const data = await fetchWithTimeout(url, {}, 15000)
    if (!data?.data?.[0]) return null
    const d = data.data[0]
    const totalTrades = d.totalTrade || 0
    const totalWin = d.totalWin || 0
    return {
      win_rate: totalTrades > 0 ? Math.round((totalWin / totalTrades) * 1000) / 10 : null,
      max_drawdown: d.maxDrawdown != null ? Math.abs(d.maxDrawdown) : null,
      sharpe_ratio: null,
    }
  } catch { return null }
}

async function fetchHyperliquidDetail(traderId) {
  // Fetch fills and compute metrics
  try {
    const data = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'userFills', user: traderId })
    }, 15000)

    if (!Array.isArray(data) || data.length === 0) return null

    // Filter to last 90 days
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
    const recentFills = data.filter(f => f.time && f.time > cutoff)
    if (recentFills.length === 0) return null

    // Compute win_rate from closed positions (closedPnl !== "0")
    const closedFills = recentFills.filter(f => f.closedPnl && parseFloat(f.closedPnl) !== 0)
    const wins = closedFills.filter(f => parseFloat(f.closedPnl) > 0)
    const winRate = closedFills.length > 0 ? Math.round((wins.length / closedFills.length) * 1000) / 10 : null

    // Compute MDD from cumulative PnL curve
    let cumPnl = 0, peak = 0, maxDD = 0
    // Sort by time
    closedFills.sort((a, b) => a.time - b.time)
    for (const fill of closedFills) {
      cumPnl += parseFloat(fill.closedPnl)
      if (cumPnl > peak) peak = cumPnl
      if (peak > 0) {
        const dd = ((peak - cumPnl) / peak) * 100
        if (dd > maxDD) maxDD = dd
      }
    }

    // Compute Sharpe from daily PnL returns
    const dailyPnl = new Map()
    for (const fill of closedFills) {
      const day = new Date(fill.time).toISOString().slice(0, 10)
      dailyPnl.set(day, (dailyPnl.get(day) || 0) + parseFloat(fill.closedPnl))
    }
    const dailyReturns = [...dailyPnl.values()]
    let sharpe = null
    if (dailyReturns.length >= 7) {
      const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
      const variance = dailyReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / dailyReturns.length
      const std = Math.sqrt(variance)
      if (std > 0) {
        sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
        if (sharpe < -10 || sharpe > 10) sharpe = null
      }
    }

    return {
      win_rate: winRate,
      max_drawdown: maxDD > 0 ? Math.round(Math.min(maxDD, 100) * 100) / 100 : null,
      sharpe_ratio: sharpe,
    }
  } catch { return null }
}

async function fetchDriftDetail(traderId) {
  try {
    const url = `https://data.api.drift.trade/authority/${traderId}/snapshots/trading?days=90`
    const data = await fetchWithTimeout(url, {}, 15000)
    if (!data?.snapshots || data.snapshots.length === 0) return null

    const snapshots = data.snapshots

    // Win rate from trade results
    const trades = snapshots.filter(s => s.pnl != null && s.pnl !== 0)
    const wins = trades.filter(s => s.pnl > 0)
    const winRate = trades.length > 0 ? Math.round((wins.length / trades.length) * 1000) / 10 : null

    // MDD from cumulative PnL
    let cumPnl = 0, peak = 0, maxDD = 0
    for (const snap of snapshots) {
      if (snap.cumulativePnl != null) cumPnl = snap.cumulativePnl
      else if (snap.pnl != null) cumPnl += snap.pnl
      if (cumPnl > peak) peak = cumPnl
      if (peak > 0) {
        const dd = ((peak - cumPnl) / peak) * 100
        if (dd > maxDD) maxDD = dd
      }
    }

    // Sharpe from daily returns
    const dailyReturns = []
    for (let i = 1; i < snapshots.length; i++) {
      const curr = snapshots[i].cumulativePnl ?? 0
      const prev = snapshots[i-1].cumulativePnl ?? 0
      dailyReturns.push(curr - prev)
    }
    let sharpe = null
    if (dailyReturns.length >= 7) {
      const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
      const variance = dailyReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / dailyReturns.length
      const std = Math.sqrt(variance)
      if (std > 0) {
        sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
        if (sharpe < -10 || sharpe > 10) sharpe = null
      }
    }

    return {
      win_rate: winRate,
      max_drawdown: maxDD > 0 ? Math.round(Math.min(maxDD, 100) * 100) / 100 : null,
      sharpe_ratio: sharpe,
    }
  } catch { return null }
}

async function fetchAevoDetail(traderId) {
  try {
    const url = `https://api.aevo.xyz/account/${traderId}/statistics`
    const data = await fetchWithTimeout(url)
    if (!data) return null

    const winRate = data.win_rate != null ? Number(data.win_rate) * 100 : null
    const mdd = data.max_drawdown != null ? Math.abs(Number(data.max_drawdown) * 100) : null
    const sharpe = data.sharpe_ratio != null ? Number(data.sharpe_ratio) : null

    return {
      win_rate: winRate != null && !isNaN(winRate) ? Math.round(winRate * 10) / 10 : null,
      max_drawdown: mdd != null && !isNaN(mdd) ? Math.round(mdd * 100) / 100 : null,
      sharpe_ratio: sharpe != null && !isNaN(sharpe) && sharpe > -10 && sharpe < 10 ? Math.round(sharpe * 100) / 100 : null,
    }
  } catch { return null }
}

async function fetchJupiterDetail(traderId) {
  try {
    // Jupiter perps leaderboard API
    const url = `https://perps-api.jup.ag/v1/leaderboard/trader/${traderId}`
    const data = await fetchWithTimeout(url, {}, 15000)
    if (!data) return null

    const winRate = data.win_rate != null ? Number(data.win_rate) * 100 :
                    (data.wins != null && data.total_trades > 0 ? Math.round((data.wins / data.total_trades) * 1000) / 10 : null)
    const mdd = data.max_drawdown != null ? Math.abs(Number(data.max_drawdown)) : null

    return {
      win_rate: winRate != null && !isNaN(winRate) ? Math.round(winRate * 10) / 10 : null,
      max_drawdown: mdd != null && !isNaN(mdd) ? Math.round(Math.min(mdd, 100) * 100) / 100 : null,
      sharpe_ratio: null,
    }
  } catch { return null }
}

async function fetchCoinexDetail(traderId) {
  try {
    const url = `https://www.coinex.com/res/copy-trade/v1/trader/detail?uid=${traderId}`
    const data = await fetchWithTimeout(url)
    if (!data?.data) return null
    const d = data.data
    const toNum = (v) => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n }
    const rawMdd = toNum(d.max_drawdown ?? d.maxDrawdown ?? d.mdd)
    const mdd = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null
    const rawWr = toNum(d.win_rate ?? d.winRate)
    const wr = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
    return {
      win_rate: wr != null ? Math.round(wr * 10) / 10 : null,
      max_drawdown: mdd != null ? Math.round(mdd * 100) / 100 : null,
      sharpe_ratio: null,
    }
  } catch { return null }
}

async function fetchBlofinDetail(traderId) {
  try {
    // BloFin uses VPS proxy
    const url = `https://openapi.blofin.com/api/v1/copytrading/public/trader/${traderId}?period=90`
    const data = await fetchViaProxy(url)
    if (!data?.data) return null
    const d = data.data
    const safeNum = (v) => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n }
    const rawWr = safeNum(d.winRate)
    const rawMdd = safeNum(d.maxDrawdown)
    return {
      win_rate: rawWr != null ? Math.abs(rawWr <= 1 ? rawWr * 100 : rawWr) : null,
      max_drawdown: rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null,
      sharpe_ratio: safeNum(d.sharpeRatio),
    }
  } catch { return null }
}

async function fetchPhemexDetail(traderId) {
  try {
    const url = `https://api.phemex.com/copy-trading/public/trader/${traderId}/detail?period=90d`
    const data = await fetchWithTimeout(url)
    if (!data?.data) return null
    const d = data.data
    const safeNum = (v) => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n }
    const rawWr = safeNum(d.winRate)
    const rawMdd = safeNum(d.maxDrawdown)
    return {
      win_rate: rawWr != null ? Math.abs(rawWr <= 1 ? rawWr * 100 : rawWr) : null,
      max_drawdown: rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null,
      sharpe_ratio: null,
    }
  } catch { return null }
}

async function fetchBingxDetail(traderId) {
  try {
    // BingX via CF proxy or VPS scraper
    const url = `https://api.bingx.com/api/v1/copy/internal/trader/detail?uid=${traderId}`
    const data = await fetchViaCFProxy(url)
    if (!data?.data) return null
    const d = data.data
    const stat = d.stat || d
    const safeNum = (v) => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n }
    const rawWr = safeNum(stat.winRate ?? stat.winRatio)
    const rawMdd = safeNum(stat.maxDrawdown ?? stat.mdd ?? d.mdd)
    return {
      win_rate: rawWr != null ? Math.abs(rawWr <= 1 ? rawWr * 100 : rawWr) : null,
      max_drawdown: rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null,
      sharpe_ratio: null,
    }
  } catch { return null }
}

async function fetchToobitDetail(traderId) {
  try {
    // Toobit via VPS scraper
    const data = await fetchViaScraper(`/toobit/trader-detail?uid=${traderId}`, 15000)
    if (!data?.data) return null
    const d = data.data
    const safeNum = (v) => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n }
    const rawWr = safeNum(d.winRate)
    const rawMdd = safeNum(d.maxDrawdown)
    return {
      win_rate: rawWr != null ? Math.abs(rawWr <= 1 ? rawWr * 100 : rawWr) : null,
      max_drawdown: rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null,
      sharpe_ratio: safeNum(d.sharpeRatio),
    }
  } catch { return null }
}

async function fetchBitunixDetail(traderId) {
  try {
    const url = `https://www.bitunix.com/api/copy-trading/v1/trader/detail?uid=${traderId}`
    const data = await fetchViaProxy(url)
    if (!data?.data) return null
    const d = data.data
    const toNum = (v) => { if (v == null) return null; const n = typeof v === 'string' ? parseFloat(v) : Number(v); return isNaN(n) ? null : n }
    const rawWr = toNum(d.winRate)
    const rawMdd = toNum(d.maxDrawDown ?? d.maxDrawdown)
    return {
      win_rate: rawWr != null ? Math.round(rawWr * 1000) / 10 : null,
      max_drawdown: rawMdd != null ? Math.abs(rawMdd * 100) : null,
      sharpe_ratio: toNum(d.sharpeRatio),
    }
  } catch { return null }
}

async function fetchBtccDetail(traderId) {
  try {
    const url = `https://www.btcc.com/api/v1/copytrade/trader/detail?traderUid=${traderId}`
    const data = await fetchWithTimeout(url)
    if (!data?.data) return null
    const d = data.data
    const toNum = (v) => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n }
    return {
      win_rate: toNum(d.winRate) != null ? toNum(d.winRate) * 100 : null,
      max_drawdown: d.maxBackRate != null ? Math.abs(Number(d.maxBackRate) * 100) : null,
      sharpe_ratio: null,
    }
  } catch { return null }
}

async function fetchEtoroDetail(traderId) {
  try {
    const url = `https://www.etoro.com/sapi/userstats/stats/portfolio/public?username=${traderId}`
    const data = await fetchViaProxy(url, 15000)
    if (!data?.Data) return null
    const d = data.Data
    return {
      win_rate: d.ProfitableWeeksPct != null ? Number(d.ProfitableWeeksPct) * 100 : null,
      max_drawdown: d.PeakToValley != null ? Math.abs(Number(d.PeakToValley) * 100) : null,
      sharpe_ratio: null,
    }
  } catch { return null }
}

async function fetchBitfinexDetail(traderId) {
  // Bitfinex: compute from rankings API data
  // The traderId for bitfinex is the ranking key
  try {
    const url = `https://api-pub.bitfinex.com/v2/rankings/${traderId}:3M:tGLOBAL:USD/hist`
    const data = await fetchWithTimeout(url, {}, 10000)
    if (!Array.isArray(data) || data.length === 0) return null

    // Each entry: [MTS, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, VOL, PNL, ...]
    // Compute from PnL timeseries
    const pnls = data.map(d => Number(d[5])).filter(n => !isNaN(n))
    if (pnls.length < 2) return null

    const wins = pnls.filter(p => p > 0)
    const winRate = pnls.length > 0 ? Math.round((wins.length / pnls.length) * 1000) / 10 : null

    // MDD from cumulative PnL
    let cumPnl = 0, peak = 0, maxDD = 0
    for (const pnl of pnls) {
      cumPnl += pnl
      if (cumPnl > peak) peak = cumPnl
      if (peak > 0) {
        const dd = ((peak - cumPnl) / peak) * 100
        if (dd > maxDD) maxDD = dd
      }
    }

    return {
      win_rate: winRate,
      max_drawdown: maxDD > 0 ? Math.round(Math.min(maxDD, 100) * 100) / 100 : null,
      sharpe_ratio: null,
    }
  } catch { return null }
}

// For GMX, Gains, Kwenta — compute from on-chain position data already in DB
async function fetchFromEquityCurveDB(platform, traderId) {
  try {
    // trader_equity_curve uses `source` and `source_trader_id` columns, with roi_pct and data_date
    const { data: ec } = await supabase
      .from('trader_equity_curve')
      .select('roi_pct, pnl_usd, data_date')
      .eq('source', platform)
      .eq('source_trader_id', traderId)
      .order('data_date', { ascending: true })
      .limit(200)

    if (!ec || ec.length < 3) return null

    // Use roi_pct if available, otherwise build from pnl_usd
    const roiValues = []
    for (const point of ec) {
      const v = point.roi_pct != null ? parseFloat(String(point.roi_pct)) : null
      if (v != null && !isNaN(v)) roiValues.push(v)
    }

    // If no ROI data, try to build cumulative PnL curve
    if (roiValues.length < 3) {
      const pnlValues = []
      for (const point of ec) {
        const v = point.pnl_usd != null ? parseFloat(String(point.pnl_usd)) : null
        if (v != null && !isNaN(v)) pnlValues.push(v)
      }
      if (pnlValues.length >= 3) {
        // Compute MDD from PnL curve
        let peak = -Infinity, maxDD = 0
        for (const v of pnlValues) {
          if (v > peak) peak = v
          if (peak > 0) {
            const dd = ((peak - v) / peak) * 100
            if (dd > maxDD) maxDD = dd
          }
        }
        // Compute Sharpe from daily PnL changes
        let sharpe = null
        if (pnlValues.length >= 7) {
          const returns = []
          for (let i = 1; i < pnlValues.length; i++) returns.push(pnlValues[i] - pnlValues[i - 1])
          const mean = returns.reduce((s, r) => s + r, 0) / returns.length
          const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length
          const std = Math.sqrt(variance)
          if (std > 0) {
            sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
            if (sharpe < -10 || sharpe > 10) sharpe = null
          }
        }
        return {
          win_rate: null,
          max_drawdown: maxDD > 0 ? Math.round(Math.min(maxDD, 100) * 100) / 100 : null,
          sharpe_ratio: sharpe,
        }
      }
      return null
    }

    // MDD from ROI equity curve
    let peakRoi = -Infinity, maxDD = 0
    for (const v of roiValues) {
      if (v > peakRoi) peakRoi = v
      if (peakRoi > 0) {
        const dd = peakRoi - v
        if (dd > maxDD) maxDD = dd
      }
    }

    // Sharpe from daily ROI returns
    let sharpe = null
    if (roiValues.length >= 7) {
      const returns = []
      for (let i = 1; i < roiValues.length; i++) {
        returns.push(roiValues[i] - roiValues[i - 1])
      }
      const mean = returns.reduce((s, r) => s + r, 0) / returns.length
      const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length
      const std = Math.sqrt(variance)
      if (std > 0) {
        sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
        if (sharpe < -10 || sharpe > 10) sharpe = null
      }
    }

    return {
      win_rate: null, // Can't determine from equity curve alone
      max_drawdown: maxDD > 0 ? Math.round(Math.min(maxDD, 100) * 100) / 100 : null,
      sharpe_ratio: sharpe,
    }
  } catch { return null }
}

// For positions-based platforms: compute from DB position history
async function fetchFromPositionHistoryDB(platform, traderId) {
  try {
    const { data: positions } = await supabase
      .from('trader_position_history')
      .select('pnl_usd')
      .eq('source', platform)
      .eq('source_trader_id', traderId)
      .not('pnl_usd', 'is', null)
      .order('close_time', { ascending: true })
      .limit(500)

    if (!positions || positions.length < 3) return null

    const pnls = positions.map(p => Number(p.pnl_usd)).filter(n => !isNaN(n))
    if (pnls.length < 3) return null

    const wins = pnls.filter(p => p > 0)
    const winRate = Math.round((wins.length / pnls.length) * 1000) / 10

    // MDD from cumulative PnL
    let cumPnl = 0, peak = 0, maxDD = 0
    for (const pnl of pnls) {
      cumPnl += pnl
      if (cumPnl > peak) peak = cumPnl
      if (peak > 0) {
        const dd = ((peak - cumPnl) / peak) * 100
        if (dd > maxDD) maxDD = dd
      }
    }

    return {
      win_rate: winRate,
      max_drawdown: maxDD > 0 ? Math.round(Math.min(maxDD, 100) * 100) / 100 : null,
      sharpe_ratio: null,
    }
  } catch { return null }
}

// Combined fetcher: try API first, fallback to DB data
function makeComboFetcher(apiFetcher, platform) {
  return async (traderId) => {
    // Try API first
    const apiResult = apiFetcher ? await apiFetcher(traderId).catch(() => null) : null

    // If API got all 3 fields, done
    if (apiResult && apiResult.win_rate != null && apiResult.max_drawdown != null && apiResult.sharpe_ratio != null) {
      return apiResult
    }

    // Supplement with equity curve data from DB
    const ecResult = await fetchFromEquityCurveDB(platform, traderId).catch(() => null)

    // Supplement with position history data from DB
    const posResult = await fetchFromPositionHistoryDB(platform, traderId).catch(() => null)

    // Merge: API > equity curve > positions
    return {
      win_rate: apiResult?.win_rate ?? posResult?.win_rate ?? null,
      max_drawdown: apiResult?.max_drawdown ?? ecResult?.max_drawdown ?? posResult?.max_drawdown ?? null,
      sharpe_ratio: apiResult?.sharpe_ratio ?? ecResult?.sharpe_ratio ?? null,
    }
  }
}

// ============ Main ============

const PLATFORM_FETCHERS = {
  binance_futures: makeComboFetcher(fetchBinanceFuturesDetail, 'binance_futures'),
  binance_spot: makeComboFetcher(fetchBinanceSpotDetail, 'binance_spot'),
  okx_futures: makeComboFetcher(fetchOkxDetail, 'okx_futures'),
  bitget_futures: makeComboFetcher(fetchBitgetDetail, 'bitget_futures'),
  mexc: makeComboFetcher(fetchMexcDetail, 'mexc'),
  htx_futures: makeComboFetcher(fetchHtxDetail, 'htx_futures'),
  gateio: makeComboFetcher(fetchGateioDetail, 'gateio'),
  hyperliquid: makeComboFetcher(fetchHyperliquidDetail, 'hyperliquid'),
  drift: makeComboFetcher(fetchDriftDetail, 'drift'),
  dydx: makeComboFetcher(fetchDydxDetail, 'dydx'),
  aevo: makeComboFetcher(fetchAevoDetail, 'aevo'),
  jupiter_perps: makeComboFetcher(fetchJupiterDetail, 'jupiter_perps'),
  coinex: makeComboFetcher(fetchCoinexDetail, 'coinex'),
  blofin: makeComboFetcher(fetchBlofinDetail, 'blofin'),
  phemex: makeComboFetcher(fetchPhemexDetail, 'phemex'),
  bingx: makeComboFetcher(fetchBingxDetail, 'bingx'),
  toobit: makeComboFetcher(fetchToobitDetail, 'toobit'),
  bitunix: makeComboFetcher(fetchBitunixDetail, 'bitunix'),
  btcc: makeComboFetcher(fetchBtccDetail, 'btcc'),
  etoro: makeComboFetcher(fetchEtoroDetail, 'etoro'),
  bitfinex: makeComboFetcher(fetchBitfinexDetail, 'bitfinex'),
  // On-chain platforms with no direct API — use DB equity curves + position history
  gmx: makeComboFetcher(null, 'gmx'),
  gains: makeComboFetcher(null, 'gains'),
  kwenta: makeComboFetcher(null, 'kwenta'),
}

async function main() {
  console.log('=== Real Data Backfill ===')
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  if (PLATFORM_FILTER) console.log(`Platform filter: ${PLATFORM_FILTER}`)
  if (LIMIT) console.log(`Limit per platform: ${LIMIT}`)

  // Print initial null counts
  console.log('\n--- Initial null counts ---')
  const { count: totalRows } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true })
  const { count: nullWr } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('win_rate', null)
  const { count: nullMdd } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('max_drawdown', null)
  const { count: nullSharpe } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('sharpe_ratio', null)
  console.log(`Total rows: ${totalRows}`)
  console.log(`Null win_rate: ${nullWr} (${Math.round((1 - nullWr/totalRows) * 100)}% coverage)`)
  console.log(`Null max_drawdown: ${nullMdd} (${Math.round((1 - nullMdd/totalRows) * 100)}% coverage)`)
  console.log(`Null sharpe_ratio: ${nullSharpe} (${Math.round((1 - nullSharpe/totalRows) * 100)}% coverage)`)

  const allResults = []

  // Get platforms to process
  const platforms = PLATFORM_FILTER
    ? [PLATFORM_FILTER].filter(p => PLATFORM_FETCHERS[p])
    : Object.keys(PLATFORM_FETCHERS)

  for (const platform of platforms) {
    const fetchFn = PLATFORM_FETCHERS[platform]
    if (!fetchFn) {
      console.log(`\n[${platform}] No fetcher configured, skipping`)
      continue
    }

    const rows = await getTradersWithNulls(platform)
    if (rows.length === 0) {
      console.log(`\n[${platform}] No null rows, skipping`)
      continue
    }

    const result = await backfillPlatform(platform, fetchFn, rows)
    allResults.push(result)
  }

  // Print final null counts
  console.log('\n\n' + '='.repeat(60))
  console.log('=== FINAL REPORT ===')
  console.log('='.repeat(60))

  const { count: finalNullWr } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('win_rate', null)
  const { count: finalNullMdd } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('max_drawdown', null)
  const { count: finalNullSharpe } = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('sharpe_ratio', null)

  console.log(`\nwin_rate:      ${nullWr} -> ${finalNullWr} null (filled ${nullWr - finalNullWr})`)
  console.log(`max_drawdown:  ${nullMdd} -> ${finalNullMdd} null (filled ${nullMdd - finalNullMdd})`)
  console.log(`sharpe_ratio:  ${nullSharpe} -> ${finalNullSharpe} null (filled ${nullSharpe - finalNullSharpe})`)

  console.log(`\nCoverage after backfill:`)
  console.log(`  win_rate:      ${Math.round((1 - finalNullWr/totalRows) * 100)}%`)
  console.log(`  max_drawdown:  ${Math.round((1 - finalNullMdd/totalRows) * 100)}%`)
  console.log(`  sharpe_ratio:  ${Math.round((1 - finalNullSharpe/totalRows) * 100)}%`)

  console.log('\nPer-platform summary:')
  for (const r of allResults) {
    console.log(`  ${r.platform.padEnd(20)} ok=${String(r.success).padStart(4)} fail=${String(r.failed).padStart(4)} skip=${String(r.skipped).padStart(4)} | wr=${r.stats.win_rate_filled} mdd=${r.stats.max_drawdown_filled} sharpe=${r.stats.sharpe_ratio_filled}`)
  }
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
