#!/usr/bin/env npx tsx
/**
 * Backfill win_rate and max_drawdown for all traders in leaderboard_ranks.
 * Directly calls exchange APIs per trader, computes WR/MDD from fills.
 *
 * Usage: npx tsx scripts/backfill-wr-mdd.ts [platform] [limit]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const BATCH = 5 // parallel requests (Hyperliquid rate limits aggressively)
const DELAY_MS = 1000 // between batches

// ─── Hyperliquid ────────────────────────────────────────────

async function enrichHyperliquid(address: string): Promise<{ wr: number | null; mdd: number | null }> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'userFills', user: address }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { wr: null, mdd: null }
    const fills = await res.json() as Array<{ closedPnl: string; side: string; dir: string }>
    if (!Array.isArray(fills) || fills.length === 0) return { wr: null, mdd: null }
    const pnls = fills.filter(f => parseFloat(f.closedPnl) !== 0).map(f => parseFloat(f.closedPnl))
    if (pnls.length === 0) return { wr: null, mdd: null }

    const wins = pnls.filter(p => p > 0).length
    const losses = pnls.filter(p => p < 0).length
    const total = wins + losses
    const wr = total > 0 ? Math.round((wins / total) * 10000) / 100 : null

    // MDD from cumulative PnL
    let cum = 0, peak = 0, maxDD = 0
    for (const p of pnls) {
      cum += p
      if (cum > peak) peak = cum
      const dd = peak - cum
      if (dd > maxDD) maxDD = dd
    }
    const mdd = peak > 0 ? Math.round((maxDD / peak) * 10000) / 100 : null

    return { wr, mdd: mdd != null && mdd <= 100 ? mdd : null }
  } catch { return { wr: null, mdd: null } }
}

// ─── dYdX (Copin) ───────────────────────────────────────────

async function enrichDydx(address: string): Promise<{ wr: number | null; mdd: number | null }> {
  try {
    const url = `https://api.copin.io/DYDX/position/statistic/filter?accounts=${address}&statisticType=MONTH`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const data = await res.json() as { data?: Array<{ totalWin?: number; totalLose?: number; maxDrawdown?: number }> }
    const stats = data?.data?.[0]
    if (!stats) return { wr: null, mdd: null }

    const wins = stats.totalWin ?? 0
    const losses = stats.totalLose ?? 0
    const total = wins + losses
    const wr = total > 0 ? Math.round((wins / total) * 10000) / 100 : null
    const mdd = stats.maxDrawdown != null ? Math.round(Math.abs(stats.maxDrawdown) * 100) / 100 : null

    return { wr, mdd: mdd != null && mdd <= 100 ? mdd : null }
  } catch { return { wr: null, mdd: null } }
}

// ─── GMX (Subsquid) ─────────────────────────────────────────

async function enrichGmx(address: string): Promise<{ wr: number | null; mdd: number | null }> {
  try {
    const query = `{ accountStats(where: { id_eq: "${address.toLowerCase()}" }, limit: 1) { wins losses closedCount netCapital maxCapital } }`
    const res = await fetch('https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json() as { data?: { accountStats?: Array<{ wins: number; losses: number; maxCapital: string; netCapital: string }> } }
    const stats = data?.data?.accountStats?.[0]
    if (!stats) return { wr: null, mdd: null }

    const wins = Number(stats.wins) || 0
    const losses = Number(stats.losses) || 0
    const total = wins + losses
    const wr = total > 0 ? Math.round((wins / total) * 10000) / 100 : null

    const maxCap = parseFloat(stats.maxCapital) / 1e30
    const netCap = parseFloat(stats.netCapital) / 1e30
    let mdd: number | null = null
    if (maxCap > 100 && netCap < maxCap) {
      mdd = Math.round(((maxCap - netCap) / maxCap) * 10000) / 100
      if (mdd > 100) mdd = null
    }

    return { wr, mdd }
  } catch { return { wr: null, mdd: null } }
}

// ─── Gains (already has WR from API, compute MDD from avg_win/avg_loss) ─

async function enrichGains(address: string): Promise<{ wr: number | null; mdd: number | null }> {
  try {
    // Gains backend doesn't have per-trader endpoint, skip
    return { wr: null, mdd: null }
  } catch { return { wr: null, mdd: null } }
}

// ─── Jupiter (Copin) ────────────────────────────────────────

async function enrichJupiter(address: string): Promise<{ wr: number | null; mdd: number | null }> {
  try {
    const url = `https://api.copin.io/JUPITER/position/statistic/filter?accounts=${address}&statisticType=MONTH`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const data = await res.json() as { data?: Array<{ totalWin?: number; totalLose?: number; maxDrawdown?: number }> }
    const stats = data?.data?.[0]
    if (!stats) return { wr: null, mdd: null }

    const wins = stats.totalWin ?? 0
    const losses = stats.totalLose ?? 0
    const total = wins + losses
    const wr = total > 0 ? Math.round((wins / total) * 10000) / 100 : null
    const mdd = stats.maxDrawdown != null ? Math.round(Math.abs(stats.maxDrawdown) * 100) / 100 : null

    return { wr, mdd: mdd != null && mdd <= 100 ? mdd : null }
  } catch { return { wr: null, mdd: null } }
}

// ─── Aevo ───────────────────────────────────────────────────

async function enrichAevo(address: string): Promise<{ wr: number | null; mdd: number | null }> {
  try {
    const res = await fetch(`https://api.aevo.xyz/account/${address}/statistics`, {
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json() as { win_rate?: number; max_drawdown?: number; total_trades?: number }
    const wr = data.win_rate != null ? Math.round(data.win_rate * 100) / 100 : null
    const mdd = data.max_drawdown != null ? Math.round(Math.abs(data.max_drawdown) * 100) / 100 : null
    return { wr, mdd: mdd != null && mdd <= 100 ? mdd : null }
  } catch { return { wr: null, mdd: null } }
}

// ─── Main ───────────────────────────────────────────────────

const ENRICHERS: Record<string, (addr: string) => Promise<{ wr: number | null; mdd: number | null }>> = {
  hyperliquid: enrichHyperliquid,
  dydx: enrichDydx,
  gmx: enrichGmx,
  jupiter_perps: enrichJupiter,
  aevo: enrichAevo,
}

async function processplatform(platform: string, limit: number) {
  const enricher = ENRICHERS[platform]
  if (!enricher) {
    console.log(`No enricher for ${platform}, skipping`)
    return
  }

  // Get traders missing WR
  const { data: missing } = await s.from('leaderboard_ranks')
    .select('id, source_trader_id')
    .eq('source', platform)
    .is('win_rate', null)
    .limit(limit)

  if (!missing?.length) {
    console.log(`${platform}: no traders need WR`)
    return
  }

  console.log(`${platform}: enriching ${missing.length} traders...`)
  let filled = 0, errors = 0

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(async (row) => {
        const { wr, mdd } = await enricher(row.source_trader_id)
        return { id: row.id, wr, mdd }
      })
    )

    for (const r of results) {
      const updates: Record<string, number> = {}
      if (r.wr != null) updates.win_rate = r.wr
      if (r.mdd != null) updates.max_drawdown = r.mdd
      if (Object.keys(updates).length > 0) {
        await s.from('leaderboard_ranks').update(updates).eq('id', r.id)
        filled++
      }
    }

    errors += results.filter(r => r.wr === null && r.mdd === null).length

    if ((i + BATCH) % 200 === 0) {
      console.log(`  ${platform}: ${i + BATCH}/${missing.length} processed, ${filled} filled, ${errors} errors`)
    }

    await new Promise(r => setTimeout(r, DELAY_MS))
  }

  console.log(`${platform}: DONE — ${filled}/${missing.length} filled`)
}

async function main() {
  const targetPlatform = process.argv[2] || 'all'
  const limit = parseInt(process.argv[3] || '5000')

  const platforms = targetPlatform === 'all'
    ? Object.keys(ENRICHERS)
    : [targetPlatform]

  for (const plat of platforms) {
    await processplatform(plat, limit)
  }

  // Print final stats
  const { count: total } = await s.from('leaderboard_ranks').select('*', { count: 'exact', head: true })
  const { count: wr } = await s.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).not('win_rate', 'is', null)
  const { count: mdd } = await s.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).not('max_drawdown', 'is', null)
  console.log(`\nFINAL: WR=${(100 * wr! / total!).toFixed(1)}% | MDD=${(100 * mdd! / total!).toFixed(1)}%`)
}

main().catch(console.error)
