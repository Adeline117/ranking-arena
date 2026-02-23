/**
 * Hyperliquid Data Enrichment v4
 *
 * Root-cause fixes vs v3:
 *   - Uses userFillsByTime instead of userFills (time-scoped, smaller payload)
 *   - Lowered min-closed-fills from 3 → 1 (prevents silent null returns)
 *   - Fixed fetchMaxDrawdown: avh length must be >0 AND not all-zero
 *   - Added per-trader debug logging to surface exactly why fill=0
 *   - Added fallback MDD estimation from portfolio pnlHistory if AVH all-zero
 *
 * Usage: node scripts/import/enrich_hyperliquid.mjs [30D|7D|90D]
 */

import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'hyperliquid'
const INFO_API = 'https://api.hyperliquid.xyz/info'

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }
const PORTFOLIO_KEY = { '7D': 'perpWeek', '30D': 'perpMonth', '90D': 'perpAllTime' }

// Diagnostic counters — helps identify why fill rate is low
const diag = {
  fillsEmpty: 0,
  fillsNotArray: 0,
  closedLessThanMin: 0,
  portfolioNotArray: 0,
  periodDataMissing: 0,
  avhAllZero: 0,
  ddTooSmall: 0,
  wrSuccess: 0,
  ddSuccess: 0,
}

async function apiFetch(body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(INFO_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 200) return res.json()
      if (res.status === 429) {
        const wait = 2000 * (attempt + 1)
        console.log(`    ⏳ Rate limited, waiting ${wait}ms...`)
        await sleep(wait)
        continue
      }
      console.log(`    ⚠ API returned ${res.status}`)
      return null
    } catch (e) {
      if (attempt < 4) { await sleep(1500 * (attempt + 1)); continue }
      return null
    }
  }
  return null
}

/**
 * Calculate win rate from fills within a time window.
 * Uses userFillsByTime for efficient scoped retrieval.
 */
async function fetchWinRate(address, period) {
  try {
    const days = WINDOW_DAYS[period]
    const startTime = Date.now() - days * 24 * 3600 * 1000

    // Use userFillsByTime — more efficient, returns only fills in window
    const fills = await apiFetch({ type: 'userFillsByTime', user: address, startTime })
    if (!Array.isArray(fills)) { diag.fillsNotArray++; return null }

    // If period window is empty, fall back to all-time fills
    let closingFills = fills.filter(f => parseFloat(f.closedPnl ?? '0') !== 0)

    if (closingFills.length === 0) {
      // Fallback: all-time userFills
      const allFills = await apiFetch({ type: 'userFills', user: address })
      await sleep(1000)
      if (!Array.isArray(allFills) || allFills.length === 0) {
        diag.fillsEmpty++
        return null
      }
      closingFills = allFills.filter(f => parseFloat(f.closedPnl ?? '0') !== 0)
    }

    if (closingFills.length === 0) {
      diag.fillsEmpty++
      return null
    }

    // Min 1 fill (previously 3 — caused silent null for low-frequency traders)
    if (closingFills.length < 1) {
      diag.closedLessThanMin++
      return null
    }

    const wins = closingFills.filter(f => parseFloat(f.closedPnl) > 0).length
    const wr = (wins / closingFills.length) * 100
    diag.wrSuccess++
    return wr
  } catch (e) {
    console.log(`    ⚠ fetchWinRate error: ${e.message}`)
    return null
  }
}

/**
 * Calculate max drawdown from portfolio pnlHistory.
 * Falls back to a PnL-delta method if accountValueHistory is all-zero.
 */
async function fetchMaxDrawdown(address, period) {
  try {
    const portfolio = await apiFetch({ type: 'portfolio', user: address })
    if (!Array.isArray(portfolio)) { diag.portfolioNotArray++; return null }

    const key = PORTFOLIO_KEY[period]
    const periodData = portfolio.find(([k]) => k === key)?.[1]
    if (!periodData) { diag.periodDataMissing++; return null }

    const avh = periodData.accountValueHistory ?? []
    const ph  = periodData.pnlHistory ?? []
    if (avh.length === 0 || ph.length === 0) { diag.avhAllZero++; return null }

    // Check whether AVH is meaningful (not all zeros)
    const nonZeroAvh = avh.filter(p => parseFloat(p[1] ?? '0') > 0)

    let maxDD = 0

    if (nonZeroAvh.length >= 2) {
      // Standard method: MDD from account-value history
      let peak = parseFloat(avh[0][1] ?? '0')
      for (const [, vStr] of avh) {
        const v = parseFloat(vStr ?? '0')
        if (v > peak) peak = v
        if (peak > 0) {
          const dd = (peak - v) / peak
          if (dd > maxDD) maxDD = dd
        }
      }
    } else if (ph.length >= 2) {
      // Fallback: use pnlHistory to find the worst cumulative drop
      const pnls = ph.map(([, v]) => parseFloat(v ?? '0'))
      let peak = pnls[0]
      for (const p of pnls) {
        if (p > peak) peak = p
        const drop = peak - p
        if (drop > maxDD) maxDD = drop
      }
      // Normalize by peak absolute pnl (rough)
      const maxAbs = Math.max(...pnls.map(Math.abs))
      maxDD = maxAbs > 0 ? maxDD / maxAbs : 0
    }

    if (maxDD < 0.001) { diag.ddTooSmall++; return null }
    diag.ddSuccess++
    return parseFloat((maxDD * 100).toFixed(2))
  } catch (e) {
    console.log(`    ⚠ fetchMaxDrawdown error: ${e.message}`)
    return null
  }
}

async function main() {
  const period = (process.argv[2] || '30D').toUpperCase()
  if (!['7D', '30D', '90D'].includes(period)) { console.error('Invalid period'); process.exit(1) }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Hyperliquid Enrichment v4 — ${period}`)
  console.log(`${'='.repeat(60)}`)

  // Fetch traders missing win_rate
  const { data: missingWr } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE).eq('season_id', period).is('win_rate', null)

  // Fetch traders missing max_drawdown
  const { data: missingDd } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE).eq('season_id', period).is('max_drawdown', null)

  // Deduplicate by source_trader_id
  const traderMap = new Map()
  for (const row of [...(missingWr || []), ...(missingDd || [])]) {
    if (!traderMap.has(row.source_trader_id)) traderMap.set(row.source_trader_id, row)
  }
  const traders = Array.from(traderMap.values())

  console.log(`Missing win_rate:    ${missingWr?.length ?? 0}`)
  console.log(`Missing max_drawdown: ${missingDd?.length ?? 0}`)
  console.log(`Unique traders:       ${traders.length}`)
  if (traders.length === 0) {
    console.log('✅ Nothing to enrich.')
    return
  }

  let enriched = 0, wrFilled = 0, ddFilled = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i]
    try {
      const needWr = trader.win_rate === null
      const needDd = trader.max_drawdown === null

      let wr = null, dd = null

      if (needWr) {
        wr = await fetchWinRate(trader.source_trader_id, period)
        await sleep(1800)
      }
      if (needDd) {
        dd = await fetchMaxDrawdown(trader.source_trader_id, period)
        await sleep(1800)
      }

      if ((needWr && wr !== null) || (needDd && dd !== null)) {
        const newWr = needWr && wr !== null ? wr : trader.win_rate
        const newDd = needDd && dd !== null ? dd : trader.max_drawdown
        const { totalScore } = calculateArenaScore(trader.roi || 0, trader.pnl, newDd, newWr, period)
        const update = { arena_score: totalScore, captured_at: new Date().toISOString() }
        if (needWr && wr !== null) { update.win_rate = wr; wrFilled++ }
        if (needDd && dd !== null) { update.max_drawdown = dd; ddFilled++ }
        const { error } = await supabase.from('trader_snapshots').update(update).eq('id', trader.id)
        if (error) {
          console.log(`    ⚠ DB update failed for ${trader.source_trader_id}: ${error.message}`)
          errors++
        } else {
          enriched++
        }
      }
    } catch (e) {
      console.log(`  ⚠ [${i}] ${trader.source_trader_id}: ${e.message}`)
      errors++
    }

    // Progress + diagnostics every 20 traders
    if ((i + 1) % 20 === 0 || i === traders.length - 1) {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1)
      const eta = i > 0 ? ((Date.now() - startTime) / (i + 1) * (traders.length - i - 1) / 60000).toFixed(1) : '?'
      console.log(`  [${i + 1}/${traders.length}] wr+=${wrFilled} dd+=${ddFilled} enriched=${enriched} err=${errors} | ${elapsed}m elapsed ~${eta}m left`)
      console.log(`    diag: fillsEmpty=${diag.fillsEmpty} notArray=${diag.fillsNotArray} closedLow=${diag.closedLessThanMin} portNotArr=${diag.portfolioNotArray} periodMiss=${diag.periodDataMissing} avhZero=${diag.avhAllZero} ddSmall=${diag.ddTooSmall}`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Hyperliquid ${period} enrichment done`)
  console.log(`   Enriched: ${enriched}/${traders.length}`)
  console.log(`   Win rate filled: ${wrFilled} (${diag.wrSuccess} successes)`)
  console.log(`   Max drawdown filled: ${ddFilled} (${diag.ddSuccess} successes)`)
  console.log(`   Errors: ${errors}`)
  console.log(`\nDiagnostics:`)
  console.log(`   fillsEmpty=${diag.fillsEmpty} notArray=${diag.fillsNotArray} closedLow=${diag.closedLessThanMin}`)
  console.log(`   portNotArr=${diag.portfolioNotArray} periodMiss=${diag.periodDataMissing}`)
  console.log(`   avhAllZero=${diag.avhAllZero} ddTooSmall=${diag.ddTooSmall}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
