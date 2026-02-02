/**
 * Hyperliquid Data Enrichment v3
 * 
 * Sequential processing with proper rate-limit handling.
 * Hyperliquid API limit: ~1 req/2s, so we do 1 trader at a time.
 * 
 * Usage: node scripts/import/enrich_hyperliquid.mjs [30D|7D|90D]
 */

import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'hyperliquid'
const INFO_API = 'https://api.hyperliquid.xyz/info'

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }
const PORTFOLIO_KEY = { '7D': 'perpWeek', '30D': 'perpMonth', '90D': 'perpAllTime' }

async function apiFetch(body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(INFO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (res.status === 200) {
      return res.json()
    }
    if (res.status === 429) {
      const wait = 2000 * (attempt + 1)
      await sleep(wait)
      continue
    }
    throw new Error(`API ${res.status}`)
  }
  return null
}

async function fetchWinRate(address, period) {
  try {
    const fills = await apiFetch({ type: 'userFills', user: address })
    if (!Array.isArray(fills) || fills.length === 0) return null

    const days = WINDOW_DAYS[period]
    const cutoff = Date.now() - days * 24 * 3600 * 1000

    // Try period-scoped fills first, fallback to all
    let closed = fills.filter(f => f.time >= cutoff && parseFloat(f.closedPnl || '0') !== 0)
    if (closed.length < 3) {
      closed = fills.filter(f => parseFloat(f.closedPnl || '0') !== 0)
    }
    if (closed.length < 3) return null

    const wins = closed.filter(f => parseFloat(f.closedPnl) > 0).length
    return (wins / closed.length) * 100
  } catch { return null }
}

async function fetchMaxDrawdown(address, period) {
  try {
    const portfolio = await apiFetch({ type: 'portfolio', user: address })
    if (!Array.isArray(portfolio)) return null

    const key = PORTFOLIO_KEY[period]
    const periodData = portfolio.find(([k]) => k === key)?.[1]
    if (!periodData?.accountValueHistory || !periodData?.pnlHistory) return null

    const avh = periodData.accountValueHistory
    const ph = periodData.pnlHistory
    if (avh.length === 0 || ph.length === 0) return null

    let maxDD = 0
    for (let i = 0; i < ph.length; i++) {
      const startAV = parseFloat(avh[i]?.[1] || '0')
      const startPnl = parseFloat(ph[i][1])
      if (startAV <= 0) continue
      for (let j = i + 1; j < ph.length; j++) {
        const endPnl = parseFloat(ph[j][1])
        const dd = (endPnl - startPnl) / startAV
        if (dd < maxDD) maxDD = dd
      }
    }
    return Math.abs(maxDD) > 0.001 ? Math.abs(maxDD) * 100 : null
  } catch { return null }
}

async function main() {
  const period = (process.argv[2] || '30D').toUpperCase()
  if (!['7D', '30D', '90D'].includes(period)) { console.error('Invalid period'); process.exit(1) }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Hyperliquid Enrichment v3 — ${period} (sequential)`)
  console.log(`${'='.repeat(60)}`)

  const { data: missingWr } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE).eq('season_id', period).is('win_rate', null)

  const { data: missingDd } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE).eq('season_id', period).is('max_drawdown', null)

  const traderMap = new Map()
  for (const row of [...(missingWr || []), ...(missingDd || [])]) {
    if (!traderMap.has(row.source_trader_id)) traderMap.set(row.source_trader_id, row)
  }
  const traders = Array.from(traderMap.values())

  console.log(`Missing win_rate: ${missingWr?.length || 0}`)
  console.log(`Missing max_drawdown: ${missingDd?.length || 0}`)
  console.log(`Unique traders: ${traders.length}`)
  console.log(`Estimated time: ~${Math.ceil(traders.length * 5 / 60)} min`)
  if (traders.length === 0) { console.log('Nothing to do!'); return }

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
        await sleep(2000)  // Rate limit pause
      }

      if (needDd) {
        dd = await fetchMaxDrawdown(trader.source_trader_id, period)
        await sleep(2000)
      }

      const newWr = needWr && wr !== null ? wr : trader.win_rate
      const newDd = needDd && dd !== null ? dd : trader.max_drawdown

      if ((needWr && wr !== null) || (needDd && dd !== null)) {
        const { totalScore } = calculateArenaScore(trader.roi || 0, trader.pnl, newDd, newWr, period)
        const update = { arena_score: totalScore }
        if (needWr && wr !== null) { update.win_rate = wr; wrFilled++ }
        if (needDd && dd !== null) { update.max_drawdown = dd; ddFilled++ }
        await supabase.from('trader_snapshots').update(update).eq('id', trader.id)
        enriched++
      }
    } catch (e) { errors++ }

    if ((i + 1) % 20 === 0 || i === traders.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      const eta = traders.length > 0 ? ((Date.now() - startTime) / (i + 1) * (traders.length - i - 1) / 60000).toFixed(1) : '0'
      console.log(`  [${i + 1}/${traders.length}] wr+=${wrFilled} dd+=${ddFilled} enriched=${enriched} err=${errors} | ${elapsed}m elapsed, ~${eta}m left`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Hyperliquid ${period} enrichment done`)
  console.log(`   Enriched: ${enriched}/${traders.length}`)
  console.log(`   Win rate filled: ${wrFilled}`)
  console.log(`   Max drawdown filled: ${ddFilled}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
