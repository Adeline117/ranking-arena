/**
 * Advanced Metrics Enrichment — Sharpe, Sortino, avg_holding_hours
 *
 * Strategy by source type:
 *
 * CEX (binance, bybit, bitget, okx, mexc, kucoin, blofin, etc.):
 *   Sharpe/Sortino estimated from ROI + MDD using Calmar-based conversion:
 *     sharpe  ≈ (roi/100) / std_est × sqrt(T)
 *     std_est ≈ mdd / 2 (rough: max drawdown ≈ 2σ for normally distributed returns)
 *
 * Hyperliquid:
 *   Actual daily returns from portfolio pnlHistory → Sharpe, Sortino, Calmar
 *
 * dYdX:
 *   Same as Hyperliquid via historical-pnl endpoint
 *
 * Gains:
 *   avgHoldingHours from personal-trading-history via CF Worker
 *
 * Usage: node scripts/import/enrich_advanced_metrics.mjs [--source=hyperliquid] [--period=90D] [--limit=500]
 */
import { getSupabaseClient, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const args = process.argv.slice(2)
const SOURCE_FILTER = args.find(a => a.startsWith('--source='))?.split('=')[1] || null
const PERIOD_FILTER = args.find(a => a.startsWith('--period='))?.split('=')[1]?.toUpperCase() || null
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '500')

// Annualization factor by period
const PERIOD_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

// ──────────────────────────────────────────────
// Statistical helpers
// ──────────────────────────────────────────────

/** Sharpe ratio from daily returns array. Risk-free rate = 0 (crypto). */
function sharpeRatio(returns) {
  if (returns.length < 5) return null
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  const std = Math.sqrt(variance)
  return std > 0 ? (mean / std) * Math.sqrt(365) : null
}

/** Sortino ratio (only downside deviation in denominator). */
function sortinoRatio(returns) {
  if (returns.length < 5) return null
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const negReturns = returns.filter(r => r < 0)
  if (negReturns.length === 0) return null
  const downsideVar = negReturns.reduce((s, r) => s + r ** 2, 0) / returns.length
  const downsideDev = Math.sqrt(downsideVar)
  return downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(365) : null
}

/**
 * Estimate Sharpe from ROI and MDD (CEX traders without daily returns).
 * Assumes returns are roughly log-normal; σ ≈ MDD / (2 × sqrt(T)).
 */
function estimateSharpeFromRoiMdd(roi, mdd, periodDays) {
  if (!roi || !mdd || mdd <= 0) return null
  const T = periodDays / 365
  // Annual return
  const annualRoi = roi / 100
  // Annualized vol estimate: MDD/period ≈ σ×sqrt(T) at some probability level
  // Using σ ≈ MDD/100 / (2×sqrt(T)) (empirical approximation)
  const periodVol = (mdd / 100) / 2
  const annualVol = periodVol / Math.sqrt(T)
  if (annualVol <= 0) return null
  const sharpe = annualRoi / annualVol
  // Clamp to reasonable range
  return Math.max(-10, Math.min(10, sharpe))
}

/**
 * Estimate Sortino from Sharpe assuming typical skew ratio ≈ 0.7.
 * (downside dev ≈ 70% of total std for typical trading returns)
 */
function estimateSortinoFromSharpe(sharpe) {
  if (!sharpe) return null
  return sharpe / 0.7  // Sortino typically 1.3-1.5× Sharpe for positive skew
}

// ──────────────────────────────────────────────
// DEX-specific enrichment (actual returns)
// ──────────────────────────────────────────────

async function fetchHlPortfolio(address) {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'portfolio', user: address }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function enrichHyperliquid(snap) {
  const portfolio = await fetchHlPortfolio(snap.source_trader_id)
  if (!Array.isArray(portfolio)) return null

  const periodKey = { '7D': 'perpWeek', '30D': 'perpMonth', '90D': 'perpAllTime' }[snap.season_id]
  const data = portfolio.find(([k]) => k === periodKey)?.[1]
  if (!data?.pnlHistory?.length) return null

  const pnls = data.pnlHistory.map(([, v]) => parseFloat(v))
  const avhs = data.accountValueHistory?.map(([, v]) => parseFloat(v)) || []

  // Compute daily returns from equity series
  const returns = []
  for (let i = 1; i < avhs.length; i++) {
    const prev = avhs[i - 1]
    if (prev > 0) returns.push((avhs[i] - prev) / prev * 100)
  }

  if (returns.length < 3) {
    // Fallback: use pnl delta returns
    for (let i = 1; i < pnls.length; i++) {
      const delta = pnls[i] - pnls[i - 1]
      const base = Math.abs(pnls[i - 1]) || 1
      returns.push((delta / base) * 100)
    }
  }

  return {
    sharpe:  sharpeRatio(returns),
    sortino: sortinoRatio(returns),
  }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function enrichDydx(snap) {
  // Fetch historical PnL
  const url1 = `https://indexer.dydx.trade/v4/historical-pnl?address=${snap.source_trader_id}&subaccountNumber=0&limit=90`
  const url2 = `${CF_PROXY}/dydx/historical-pnl?address=${snap.source_trader_id}&limit=90`

  let series = null
  for (const url of [url1, url2]) {
    const data = await fetchJson(url)
    if (data?.historicalPnl?.length) { series = data.historicalPnl; break }
  }
  if (!series?.length) return null

  const sorted = [...series].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  const equities = sorted.map(p => parseFloat(p.equity || '0'))

  const returns = []
  for (let i = 1; i < equities.length; i++) {
    const prev = equities[i - 1]
    if (prev > 0) returns.push((equities[i] - prev) / prev * 100)
  }

  return {
    sharpe:  sharpeRatio(returns),
    sortino: sortinoRatio(returns),
  }
}

async function enrichGainsAvgHolding(snap) {
  const url = `${CF_PROXY}/gains/trader-stats?address=${snap.source_trader_id}&chainId=42161`
  const data = await fetchJson(url)
  if (!data) return null

  const avgHolding = data.avgHoldingTime || data.averageHoldingTime
  if (!avgHolding) return null

  // avgHoldingTime is in seconds or milliseconds
  const hours = avgHolding > 86400 * 365
    ? avgHolding / 3600000  // milliseconds
    : avgHolding / 3600     // seconds
  return { avgHoldingHours: parseFloat(hours.toFixed(2)) }
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
  console.log('Advanced Metrics Enrichment (Sharpe/Sortino/AvgHolding)')
  console.log(`Source filter: ${SOURCE_FILTER || 'ALL'}`)
  console.log(`Period filter: ${PERIOD_FILTER || 'ALL'}`)
  console.log(`Limit: ${LIMIT}\n`)

  // Fetch snapshots missing Sharpe/Sortino or avg_holding_hours
  let query = supabase
    .from('trader_snapshots')
    .select('id, source, source_trader_id, season_id, roi, pnl, max_drawdown, win_rate, sharpe_ratio, sortino_ratio, avg_holding_hours')
    .or('sharpe_ratio.is.null,sortino_ratio.is.null')
    .not('roi', 'is', null)
    .limit(LIMIT)

  if (SOURCE_FILTER) query = query.eq('source', SOURCE_FILTER)
  if (PERIOD_FILTER) query = query.eq('season_id', PERIOD_FILTER)

  const { data: snaps, error } = await query
  if (error) { console.error('DB error:', error.message); return }
  if (!snaps?.length) { console.log('Nothing to enrich'); return }

  console.log(`Found ${snaps.length} snapshots needing enrichment`)

  // Group by source for reporting
  const bySource = {}
  for (const s of snaps) {
    bySource[s.source] = (bySource[s.source] || 0) + 1
  }
  console.log('By source:', Object.entries(bySource).map(([k, v]) => `${k}: ${v}`).join(', '))

  let updated = 0, errors = 0

  for (let i = 0; i < snaps.length; i++) {
    const snap = snaps[i]
    try {
      const roi = parseFloat(snap.roi || '0')
      const mdd = parseFloat(snap.max_drawdown || '0')
      const periodDays = PERIOD_DAYS[snap.season_id] || 30

      let update = {}

      // DEX sources: use actual API data for more accurate metrics
      if (snap.source === 'hyperliquid' && (snap.sharpe_ratio == null || snap.sortino_ratio == null)) {
        const metrics = await enrichHyperliquid(snap)
        await sleep(2000)
        if (metrics?.sharpe != null) update.sharpe_ratio = parseFloat(metrics.sharpe.toFixed(4))
        if (metrics?.sortino != null) update.sortino_ratio = parseFloat(metrics.sortino.toFixed(4))
      } else if (snap.source === 'dydx' && (snap.sharpe_ratio == null || snap.sortino_ratio == null)) {
        const metrics = await enrichDydx(snap)
        await sleep(1000)
        if (metrics?.sharpe != null) update.sharpe_ratio = parseFloat(metrics.sharpe.toFixed(4))
        if (metrics?.sortino != null) update.sortino_ratio = parseFloat(metrics.sortino.toFixed(4))
      }

      if (snap.source === 'gains' && snap.avg_holding_hours == null) {
        const metrics = await enrichGainsAvgHolding(snap)
        await sleep(500)
        if (metrics?.avgHoldingHours) update.avg_holding_hours = metrics.avgHoldingHours
      }

      // CEX sources: estimate from ROI + MDD
      if (snap.sharpe_ratio == null && roi && mdd > 0) {
        const sharpe = estimateSharpeFromRoiMdd(roi, mdd, periodDays)
        if (sharpe != null) {
          update.sharpe_ratio = parseFloat(sharpe.toFixed(4))
          if (snap.sortino_ratio == null) {
            const sortino = estimateSortinoFromSharpe(sharpe)
            if (sortino != null) update.sortino_ratio = parseFloat(sortino.toFixed(4))
          }
        }
      }

      if (Object.keys(update).length > 0) {
        update.captured_at = new Date().toISOString()
        const { error: err } = await supabase
          .from('trader_snapshots')
          .update(update)
          .eq('id', snap.id)
        if (err) { errors++; continue }
        updated++
      }
    } catch (e) {
      errors++
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  [${i + 1}/${snaps.length}] updated=${updated} err=${errors}`)
    }
  }

  console.log(`\n✅ Done: updated=${updated}/${snaps.length}, errors=${errors}`)
}

main().catch(console.error)
