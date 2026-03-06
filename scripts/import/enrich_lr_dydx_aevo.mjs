#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks for dYdX and Aevo
 * - dYdX: fetch fills via proxy to compute win_rate, max_drawdown, trades_count
 * - Aevo: no public per-user trade API; skip (documented limitation)
 *
 * Uses direct pg (no supabase client) and proxy for dYdX geoblock.
 *
 * Usage:
 *   node scripts/import/enrich_lr_dydx_aevo.mjs            # both
 *   node scripts/import/enrich_lr_dydx_aevo.mjs --dydx     # dydx only
 *   node scripts/import/enrich_lr_dydx_aevo.mjs --aevo     # aevo only (no-op currently)
 */
import pg from 'pg'
import { ProxyAgent, fetch as proxyFetch } from 'undici'
import { calculateArenaScore } from '../lib/shared.mjs'

const { Client } = pg
const DB_URL = process.env.DATABASE_URL
const INDEXER = 'https://indexer.dydx.trade/v4'
const PROXY = 'http://127.0.0.1:7890'
const PERIODS = { '7D': 7, '30D': 30, '90D': 90 }

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── dYdX API helpers (via proxy to bypass geoblock) ──

const dispatcher = new ProxyAgent(PROXY)

async function dydxFetch(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await proxyFetch(url, {
        dispatcher,
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch (e) {
      if (i < 2) await sleep(2000)
    }
  }
  return null
}

async function getAllFills(address, maxDays) {
  const cutoff = Date.now() - maxDays * 86400000
  const all = []
  let cursor = null
  for (let p = 0; p < 15; p++) {
    let url = `${INDEXER}/fills?address=${address}&subaccountNumber=0&limit=100`
    if (cursor) url += `&createdBeforeOrAt=${cursor}`
    const data = await dydxFetch(url)
    if (!data?.fills?.length) break
    all.push(...data.fills)
    const oldest = new Date(data.fills[data.fills.length - 1].createdAt).getTime()
    if (oldest < cutoff) break
    cursor = data.fills[data.fills.length - 1].createdAt
    await sleep(200)
  }
  return all
}

async function getHistoricalPnl(address, maxDays) {
  const cutoff = Date.now() - maxDays * 86400000
  const all = []
  let cursor = null
  for (let p = 0; p < 20; p++) {
    let url = `${INDEXER}/historical-pnl?address=${address}&subaccountNumber=0&limit=100`
    if (cursor) url += `&createdBeforeOrAt=${cursor}`
    const data = await dydxFetch(url)
    if (!data?.historicalPnl?.length) break
    all.push(...data.historicalPnl)
    const oldest = new Date(data.historicalPnl[data.historicalPnl.length - 1].createdAt).getTime()
    if (oldest < cutoff) break
    cursor = data.historicalPnl[data.historicalPnl.length - 1].createdAt
    await sleep(200)
  }
  return all
}

function computeFromFills(fills, days) {
  const cutoff = Date.now() - days * 86400000
  const pf = fills.filter(f => new Date(f.createdAt).getTime() >= cutoff)
  if (!pf.length) return null

  const positions = new Map()
  const closed = []
  let runPnl = 0, peak = 0, maxDD = 0

  pf.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))

  for (const fill of pf) {
    const mk = fill.market
    const price = +fill.price, size = +fill.size, fee = +(fill.fee || 0)
    const side = fill.side
    if (!positions.has(mk)) positions.set(mk, { side: null, size: 0, ev: 0 })
    const pos = positions.get(mk)

    if (pos.size === 0) {
      pos.side = side === 'BUY' ? 'L' : 'S'
      pos.size = size; pos.ev = price * size
    } else if ((pos.side === 'L' && side === 'BUY') || (pos.side === 'S' && side === 'SELL')) {
      pos.ev += price * size; pos.size += size
    } else {
      const avg = pos.ev / pos.size
      const cs = Math.min(size, pos.size)
      const pnl = pos.side === 'L' ? (price - avg) * cs - fee : (avg - price) * cs - fee
      pos.size -= cs
      pos.ev = pos.size > 0.0001 ? avg * pos.size : 0
      if (pos.size <= 0.0001) {
        closed.push(pnl); pos.size = 0; pos.ev = 0; pos.side = null
        if (size > cs + 0.0001) {
          pos.side = side === 'BUY' ? 'L' : 'S'
          pos.size = size - cs; pos.ev = price * (size - cs)
        }
      } else {
        closed.push(pnl)
      }
      runPnl += pnl
      if (runPnl > peak) peak = runPnl
      const dd = peak > 0 ? (peak - runPnl) / peak * 100 : 0
      if (dd > maxDD) maxDD = dd
    }
  }
  if (!closed.length) return null
  const wins = closed.filter(p => p > 0).length
  return {
    win_rate: Math.round(wins / closed.length * 1000) / 10,
    trades_count: closed.length,
    max_drawdown: Math.round(maxDD * 10) / 10,
  }
}

function computeDrawdownFromPnl(pnlData, days) {
  const cutoff = Date.now() - days * 86400000
  const pts = pnlData
    .filter(p => new Date(p.createdAt).getTime() >= cutoff)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  if (pts.length < 2) return null
  let peak = 0, maxDD = 0
  for (const p of pts) {
    const eq = +p.equity
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = (peak - eq) / peak * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  return Math.round(maxDD * 10) / 10
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2)
  const doDydx = !args.includes('--aevo')
  const doAevo = args.includes('--aevo') || (!args.includes('--dydx') && !args.includes('--aevo'))

  const db = new Client(DB_URL)
  await db.connect()
  console.log('Connected to DB\n')

  if (doDydx) {
    console.log('═══ dYdX Enrichment ═══')
    // Get all dydx rows with null win_rate
    const { rows } = await db.query(
      `SELECT id, source_trader_id, season_id, roi, pnl, win_rate, max_drawdown, trades_count
       FROM leaderboard_ranks WHERE source='dydx' AND win_rate IS NULL`
    )
    console.log(`Rows needing enrichment: ${rows.length}`)

    // Group by trader
    const byTrader = new Map()
    for (const r of rows) {
      if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
      byTrader.get(r.source_trader_id).push(r)
    }
    console.log(`Unique traders: ${byTrader.size}\n`)

    let updated = 0, noData = 0, errors = 0
    let idx = 0

    for (const [addr, snaps] of byTrader) {
      idx++
      const maxDays = Math.max(...snaps.map(s => PERIODS[s.season_id] || 90))
      process.stdout.write(`  [${idx}/${byTrader.size}] ${addr.slice(0, 20)}... `)

      const fills = await getAllFills(addr, maxDays)

      if (!fills.length) {
        console.log('no fills')
        noData += snaps.length
        await sleep(300)
        continue
      }

      console.log(`${fills.length} fills`)

      for (const snap of snaps) {
        const days = PERIODS[snap.season_id] || 90
        const metrics = computeFromFills(fills, days)

        const wr = metrics?.win_rate ?? null
        const tc = metrics?.trades_count ?? null
        const mdd = metrics?.max_drawdown ?? null

        if (wr == null && mdd == null) { noData++; continue }

        const sets = []
        const vals = []
        let pi = 1
        if (wr != null) { sets.push(`win_rate=$${pi++}`); vals.push(wr) }
        if (mdd != null && snap.max_drawdown == null) { sets.push(`max_drawdown=$${pi++}`); vals.push(mdd) }
        if (tc != null && snap.trades_count == null) { sets.push(`trades_count=$${pi++}`); vals.push(tc) }

        // Recalculate arena_score
        const newWr = wr ?? snap.win_rate
        const newMdd = mdd ?? snap.max_drawdown
        const { totalScore } = calculateArenaScore(
          parseFloat(snap.roi) || 0,
          parseFloat(snap.pnl) || 0,
          newMdd, newWr, snap.season_id
        )
        sets.push(`arena_score=$${pi++}`)
        vals.push(totalScore)

        vals.push(snap.id)
        try {
          await db.query(`UPDATE leaderboard_ranks SET ${sets.join(',')} WHERE id=$${pi}`, vals)
          updated++
        } catch (e) {
          errors++
          console.log(`    ❌ ${snap.season_id}: ${e.message}`)
        }
      }
      await sleep(500)
    }

    console.log(`\n✅ dYdX: updated=${updated}, noData=${noData}, errors=${errors}`)
  }

  if (doAevo) {
    console.log('\n═══ Aevo ═══')
    console.log('⚠ Aevo has no public per-user trade history API.')
    console.log('  Win rate / max drawdown cannot be fetched without authentication.')
    const { rows } = await db.query(
      `SELECT count(*) as cnt FROM leaderboard_ranks WHERE source='aevo' AND win_rate IS NULL`
    )
    console.log(`  ${rows[0].cnt} rows still have null win_rate. Skipping.\n`)
  }

  await db.end()
  console.log('Done.')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
