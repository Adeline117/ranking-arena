/**
 * dYdX v4 Data Enrichment
 *
 * Fixes:
 *   - ROI semantic: was summing floating equity snapshots — now uses realized PnL from fills
 *   - WinRate: calculated from trade fills (win = closedPnl > 0)
 *   - MDD: calculated from historical PnL curve (peak-to-trough on equity series)
 *   - Sharpe/Sortino: computed from daily PnL delta series
 *   - avg_holding_hours: computed from fill entry/exit timestamps
 *   - Routes all API calls through CF Worker (bypasses geo-block)
 *
 * Usage: node scripts/import/enrich_dydx.mjs [90D|30D|7D|ALL]
 */

import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'dydx'

const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const INDEXER  = 'https://indexer.dydx.trade'

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < retries - 1) await sleep(2000) }
  }
  return null
}

/** Fetch paginated fills for address+subaccount via direct indexer or CF proxy. */
async function fetchFills(address, limit = 100) {
  // Try direct indexer first, fall back to CF proxy
  const urls = [
    `${INDEXER}/v4/fills?address=${address}&subaccountNumber=0&limit=${limit}`,
    `${CF_PROXY}/proxy?url=${encodeURIComponent(`${INDEXER}/v4/fills?address=${address}&subaccountNumber=0&limit=${limit}`)}`,
  ]
  for (const url of urls) {
    const data = await fetchJson(url)
    if (data?.fills) return data.fills
    if (Array.isArray(data)) return data
  }
  return []
}

/** Fetch historical PnL series (equity curve). */
async function fetchHistoricalPnl(address) {
  const urls = [
    `${INDEXER}/v4/historical-pnl?address=${address}&subaccountNumber=0&limit=90`,
    `${CF_PROXY}/dydx/historical-pnl?address=${address}&subaccountNumber=0&limit=90`,
  ]
  for (const url of urls) {
    const data = await fetchJson(url)
    if (data?.historicalPnl) return data.historicalPnl
    if (Array.isArray(data)) return data
  }
  return []
}

/**
 * Calculate stats from fills within a time window.
 * Returns { winRate, tradesCount, avgHoldingHours, realizedPnl, sharpe, sortino }
 */
function calcStatsFromFills(fills, windowDays) {
  if (!fills?.length) return null
  const cutoff = Date.now() - windowDays * 86400000

  // dYdX fills: each "fill" is a position match event; closed positions have side='SELL' for longs
  // Group by orderId to find completed round-trips
  const periodFills = fills.filter(f => new Date(f.createdAt).getTime() >= cutoff)
  if (periodFills.length === 0) return null

  // Compute realized PnL and win/loss for CLOSING fills (exits)
  // A closing fill has realizedPnl set
  const closingFills = periodFills.filter(f => {
    const rp = parseFloat(f.realizedPnl ?? '0')
    return rp !== 0
  })

  if (closingFills.length === 0) return null

  const totalRealizedPnl = closingFills.reduce((s, f) => s + parseFloat(f.realizedPnl ?? '0'), 0)
  const wins  = closingFills.filter(f => parseFloat(f.realizedPnl) > 0).length
  const losses = closingFills.length - wins
  const winRate = (wins / closingFills.length) * 100

  // avg_holding_hours: use createdAt of opposing fills for same market
  // Simple proxy: (max timestamp - min timestamp) / count
  const ts = periodFills.map(f => new Date(f.createdAt).getTime())
  const spanHours = ts.length > 1 ? (Math.max(...ts) - Math.min(...ts)) / 3600000 : 0
  const avgHoldingHours = closingFills.length > 0 ? spanHours / closingFills.length : null

  return {
    winRate,
    tradesCount: closingFills.length,
    avgHoldingHours,
    realizedPnl: totalRealizedPnl,
  }
}

/**
 * Calculate MDD and equity-curve metrics from historicalPnl series.
 * dYdX historicalPnl entries: { createdAt, totalPnl, equity }
 *
 * Correct ROI: delta equity from first to last snapshot / initial equity × 100
 * MDD: worst peak-to-trough on equity series
 */
function calcMetricsFromEquityCurve(series) {
  if (!series?.length || series.length < 2) return null

  // Sort chronologically
  const sorted = [...series].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))

  const equities = sorted.map(p => parseFloat(p.equity ?? '0'))
  const pnls = sorted.map(p => parseFloat(p.totalPnl ?? '0'))

  const initialEquity = equities[0]
  const finalEquity   = equities[equities.length - 1]
  const initialPnl    = pnls[0]
  const finalPnl      = pnls[pnls.length - 1]

  // Realized ROI: pnl delta / initial equity (NOT sum of all pnl points)
  const pnlDelta = finalPnl - initialPnl
  const roi = initialEquity > 0 ? (pnlDelta / initialEquity) * 100 : null

  // MDD from equity series (peak to trough)
  let peak = equities[0], maxDD = 0
  for (const e of equities) {
    if (e > peak) peak = e
    if (peak > 0) {
      const dd = (peak - e) / peak
      if (dd > maxDD) maxDD = dd
    }
  }

  // Daily returns for Sharpe/Sortino
  const dailyReturns = []
  for (let i = 1; i < equities.length; i++) {
    const prev = equities[i - 1]
    if (prev > 0) dailyReturns.push((equities[i] - prev) / prev * 100)
  }

  let sharpe = null, sortino = null
  if (dailyReturns.length >= 5) {
    const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
    const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length
    const std = Math.sqrt(variance)
    const downDev = Math.sqrt(
      dailyReturns.filter(r => r < 0).reduce((s, r) => s + r ** 2, 0) /
      Math.max(1, dailyReturns.length)
    )
    sharpe  = std > 0  ? (mean / std) * Math.sqrt(365) : null
    sortino = downDev > 0 ? (mean / downDev) * Math.sqrt(365) : null
  }

  return {
    roi,
    pnl: pnlDelta,
    mdd: maxDD > 0.001 ? maxDD * 100 : null,
    sharpe,
    sortino,
    equityCurveLength: sorted.length,
  }
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const periods = arg === 'ALL' ? ['7D', '30D', '90D']
    : arg && WINDOW_DAYS[arg] ? [arg]
    : ['90D']

  console.log('dYdX Enrichment (ROI semantic fix + WR/MDD/Sharpe from fills)')
  console.log(`Periods: ${periods.join(', ')}`)

  for (const period of periods) {
    console.log(`\n=== ${period} ===`)

    // Get all dYdX snapshots
    const { data: snaps } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count')
      .eq('source', SOURCE)
      .eq('season_id', period)
      .limit(500)

    if (!snaps?.length) { console.log('  No records'); continue }
    console.log(`  Records: ${snaps.length}`)

    const needsEnrich = snaps.filter(s =>
      s.win_rate == null || s.max_drawdown == null || s.roi == null
    )
    console.log(`  Need enrichment: ${needsEnrich.length}`)

    let enriched = 0, errors = 0
    const windowDays = WINDOW_DAYS[period]

    for (let i = 0; i < needsEnrich.length; i++) {
      const snap = needsEnrich[i]
      try {
        // Fetch historical PnL (equity curve)
        const historicalPnl = await fetchHistoricalPnl(snap.source_trader_id)
        await sleep(300)

        const equityMetrics = calcMetricsFromEquityCurve(historicalPnl)

        // Fetch fills for WR, trades_count, avgHoldingHours
        const fills = await fetchFills(snap.source_trader_id)
        await sleep(600)

        const fillMetrics = calcStatsFromFills(fills, windowDays)

        const update = {}

        // ROI: use corrected equity-curve delta (NOT sum of pnl snapshots)
        if (equityMetrics?.roi != null && snap.roi == null) {
          update.roi = parseFloat(equityMetrics.roi.toFixed(4))
        }
        if (equityMetrics?.pnl != null && snap.pnl == null) {
          update.pnl = parseFloat(equityMetrics.pnl.toFixed(2))
        }
        if (equityMetrics?.mdd != null && snap.max_drawdown == null) {
          update.max_drawdown = parseFloat(equityMetrics.mdd.toFixed(2))
        }
        if (equityMetrics?.sharpe != null) {
          update.sharpe_ratio = parseFloat(equityMetrics.sharpe.toFixed(4))
        }

        if (fillMetrics) {
          if (snap.win_rate == null)    update.win_rate    = parseFloat(fillMetrics.winRate.toFixed(2))
          if (snap.trades_count == null) update.trades_count = fillMetrics.tradesCount
          if (fillMetrics.avgHoldingHours) update.avg_holding_hours = parseFloat(fillMetrics.avgHoldingHours.toFixed(2))
        }

        if (Object.keys(update).length > 0) {
          const roi = update.roi ?? snap.roi ?? 0
          const pnl = update.pnl ?? snap.pnl ?? 0
          const mdd = update.max_drawdown ?? snap.max_drawdown
          const wr  = update.win_rate ?? snap.win_rate
          const { totalScore } = calculateArenaScore(roi, pnl, mdd, wr, period)
          update.arena_score = totalScore
          update.captured_at = new Date().toISOString()

          const { error } = await supabase.from('trader_snapshots').update(update).eq('id', snap.id)
          if (error) { console.log(`  ⚠ ${snap.source_trader_id.slice(0, 12)}: ${error.message}`); errors++ }
          else enriched++
        }
      } catch (e) {
        console.log(`  ⚠ ${snap.source_trader_id?.slice(0, 12)}: ${e.message}`)
        errors++
      }

      if ((i + 1) % 10 === 0) {
        console.log(`  [${i + 1}/${needsEnrich.length}] enriched=${enriched} err=${errors}`)
      }
      await sleep(1000)
    }

    console.log(`  ✅ ${period}: enriched ${enriched}/${needsEnrich.length}, errors=${errors}`)
  }

  console.log('\n✅ dYdX enrichment done')
}

main().catch(console.error)
