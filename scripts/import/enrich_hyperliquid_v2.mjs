#!/usr/bin/env node
/**
 * Enrich trader_snapshots_v2 for hyperliquid with win_rate, max_drawdown, trades_count
 * Uses Hyperliquid's public API (no browser needed).
 * Rate limit: ~1 req/2s
 *
 * Usage:
 *   node scripts/import/enrich_hyperliquid_v2.mjs [90d|30d|7d]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const INFO_API = 'https://api.hyperliquid.xyz/info'
const WINDOW_ARG = (process.argv[2] || '90d').toLowerCase()
const PORTFOLIO_KEY = { '7d': 'perpWeek', '30d': 'perpMonth', '90d': 'perpAllTime' }
const WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function apiFetch(body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(INFO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (res.status === 200) return res.json()
    if (res.status === 429) {
      await sleep(2000 * (attempt + 1))
      continue
    }
    throw new Error(`API ${res.status}`)
  }
  return null
}

async function fetchTraderData(address, period) {
  const result = { win_rate: null, max_drawdown: null, trades_count: null }

  // Get fills for win_rate and trades_count
  try {
    const fills = await apiFetch({ type: 'userFills', user: address })
    if (Array.isArray(fills) && fills.length > 0) {
      const days = WINDOW_DAYS[period]
      const cutoff = Date.now() - days * 24 * 3600 * 1000
      const closed = fills.filter(f => f.time >= cutoff && parseFloat(f.closedPnl || '0') !== 0)
      if (closed.length >= 3) {
        const wins = closed.filter(f => parseFloat(f.closedPnl) > 0).length
        result.win_rate = parseFloat(((wins / closed.length) * 100).toFixed(2))
        result.trades_count = closed.length
      }
    }
  } catch {}

  await sleep(2000)

  // Get portfolio for max_drawdown
  try {
    const portfolio = await apiFetch({ type: 'portfolio', user: address })
    if (Array.isArray(portfolio)) {
      const key = PORTFOLIO_KEY[period]
      const periodData = portfolio.find(([k]) => k === key)?.[1]
      if (periodData?.accountValueHistory && periodData?.pnlHistory) {
        const avh = periodData.accountValueHistory
        const ph = periodData.pnlHistory
        if (avh.length > 0 && ph.length > 0) {
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
          if (Math.abs(maxDD) > 0.001) {
            result.max_drawdown = parseFloat((Math.abs(maxDD) * 100).toFixed(2))
          }
        }
      }
    }
  } catch {}

  return result
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Hyperliquid v2 Enrichment — ${WINDOW_ARG}`)
  console.log(`${'='.repeat(60)}`)

  // Fetch all rows missing data (paginate past 1000 limit)
  let rows = []
  let page = 0
  const PAGE_SIZE = 1000
  while (true) {
    const { data, error: e } = await sb.from('trader_snapshots_v2')
      .select('id, trader_key, window')
      .eq('platform', 'hyperliquid')
      .eq('window', WINDOW_ARG)
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .order('trader_key')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (e) { console.error('DB error:', e.message); return }
    if (!data?.length) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
    page++
  }

  console.log(`Found ${rows.length} rows to enrich`)
  if (!rows.length) return

  // Deduplicate by trader_key
  const byTrader = new Map()
  for (const r of rows) {
    if (!byTrader.has(r.trader_key)) byTrader.set(r.trader_key, [])
    byTrader.get(r.trader_key).push(r)
  }
  const traderKeys = [...byTrader.keys()]
  console.log(`Unique traders: ${traderKeys.length}`)
  console.log(`Estimated time: ~${Math.ceil(traderKeys.length * 5 / 60)} min\n`)

  let enriched = 0, wrFilled = 0, ddFilled = 0, tcFilled = 0, errors = 0

  for (let i = 0; i < traderKeys.length; i++) {
    const key = traderKeys[i]
    const snapshots = byTrader.get(key)
    try {
      const data = await fetchTraderData(key, WINDOW_ARG)
      const update = {}
      if (data.win_rate !== null) { update.win_rate = data.win_rate; wrFilled++ }
      if (data.max_drawdown !== null) { update.max_drawdown = data.max_drawdown; ddFilled++ }
      if (data.trades_count !== null) { update.trades_count = data.trades_count; tcFilled++ }

      if (Object.keys(update).length > 0) {
        for (const s of snapshots) {
          await sb.from('trader_snapshots_v2').update(update).eq('id', s.id)
        }
        enriched++
      }
    } catch (e) { errors++ }

    await sleep(2000)

    if ((i + 1) % 50 === 0 || i === traderKeys.length - 1) {
      console.log(`  [${i + 1}/${traderKeys.length}] wr+=${wrFilled} dd+=${ddFilled} tc+=${tcFilled} enriched=${enriched} err=${errors}`)
    }
  }

  console.log(`\n✅ Done: ${enriched}/${traderKeys.length} traders enriched`)
  console.log(`   win_rate: +${wrFilled}, max_drawdown: +${ddFilled}, trades_count: +${tcFilled}, errors: ${errors}`)
}

main().catch(console.error)
