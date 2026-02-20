#!/usr/bin/env node
/**
 * KuCoin WR/MDD Enrichment v3
 * 
 * FIX: Previous scripts used period=90d which now returns null.
 * v3 tries periods in order: 365d → 180d → 90d for positionHistory
 * and always uses 90d for pnl/history (most reliable).
 * 
 * Real API data only. No fabrication.
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.kucoin.com/copy-trading',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function clip(v, min, max) { return Math.max(min, Math.min(max, v)) }
function safeLog1p(x) { return x <= -1 ? 0 : Math.log(1 + x) }

const PARAMS = {
  '7D':  { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
}
const PNL_PARAMS = {
  '7D':  { base: 500,  coeff: 0.40 },
  '30D': { base: 2000, coeff: 0.35 },
  '90D': { base: 5000, coeff: 0.30 },
}
const CONF_MULT = { full: 1.0, partial: 0.92, minimal: 0.80 }

function calcScore(roi, pnl, maxDrawdown, winRate, seasonId) {
  const p = PARAMS[seasonId]
  if (!p || roi == null) return null
  const pp = PNL_PARAMS[seasonId] || PNL_PARAMS['90D']
  const days = seasonId === '7D' ? 7 : seasonId === '30D' ? 30 : 90
  const cappedRoi = Math.min(roi, 10000)
  const intensity = (365 / days) * safeLog1p(cappedRoi / 100)
  const r0 = Math.tanh(p.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(70 * Math.pow(r0, p.roiExponent), 0, 70) : 0
  let pnlScore = 0
  if (pnl > 0) {
    const la = 1 + pnl / pp.base
    if (la > 0) pnlScore = clip(15 * Math.tanh(pp.coeff * Math.log(la)), 0, 15)
  }
  const effMdd = (!maxDrawdown || maxDrawdown === 0) ? -20 : maxDrawdown
  const mddAbs = Math.abs(effMdd)
  const normMdd = mddAbs <= 1 ? mddAbs * 100 : mddAbs
  const drawdownScore = clip(8 * clip(1 - normMdd / p.mddThreshold, 0, 1), 0, 8)
  const effWr = (winRate == null) ? 50 : winRate
  const normWr = (effWr <= 1 && effWr >= 0) ? effWr * 100 : effWr
  const stabilityScore = clip(7 * clip((normWr - 45) / (p.winRateCap - 45), 0, 1), 0, 7)
  const hasMdd = maxDrawdown != null && maxDrawdown !== 0
  const hasWr = winRate != null && winRate !== 0
  const conf = (hasMdd && hasWr) ? 'full' : (hasMdd || hasWr) ? 'partial' : 'minimal'
  const raw = returnScore + pnlScore + drawdownScore + stabilityScore
  return Math.round(clip(raw * CONF_MULT[conf], 0, 100) * 100) / 100
}

async function fetchPositionHistory(traderId) {
  // Try periods from longest to shortest: 365d has most data available
  for (const period of ['365d', '180d', '90d']) {
    try {
      const r = await fetch(
        `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?leadConfigId=${traderId}&period=${period}&lang=en_US&pageSize=200&currentPage=1`,
        { headers: HEADERS, signal: AbortSignal.timeout(12000) }
      )
      const json = await r.json()
      if (json.data && Array.isArray(json.data) && json.data.length > 0) {
        return { data: json.data, period }
      }
      await sleep(150)
    } catch (e) {
      // continue
    }
  }
  return null
}

async function fetchPnlHistory(traderId) {
  // pnl/history: 90d consistently returns 91 data points; 180d/365d usually null
  for (const period of ['90d', '180d', '365d']) {
    try {
      const r = await fetch(
        `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/pnl/history?leadConfigId=${traderId}&period=${period}&lang=en_US`,
        { headers: HEADERS, signal: AbortSignal.timeout(12000) }
      )
      const json = await r.json()
      if (json.data && Array.isArray(json.data) && json.data.length >= 2) {
        // Check if there's any non-trivial data (ratio != -1 and ratio != 0)
        const meaningful = json.data.filter(p => {
          const ratio = parseFloat(p.ratio || 0)
          return ratio !== 0 && ratio !== -1
        })
        if (meaningful.length > 0) return { data: json.data, period }
      }
      await sleep(150)
    } catch (e) {
      // continue
    }
  }
  return null
}

function calcWinRate(positions) {
  if (!positions || positions.length === 0) return null
  const tc = positions.length
  const wins = positions.filter(p => parseFloat(p.closePnl) > 0).length
  // Require at least 1 trade to report win rate
  const wr = Math.round((wins / tc) * 10000) / 100
  return wr
}

function calcMaxDrawdown(pnlData) {
  if (!pnlData || pnlData.length < 2) return null
  const equities = pnlData.map(p => 1 + parseFloat(p.ratio || 0))
  let peak = equities[0], maxDD = 0
  for (const eq of equities) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = (peak - eq) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0.001 ? Math.round(maxDD * 10000) / 100 : null
}

async function main() {
  console.log('🚀 KuCoin Enrichment v3 - Fix for null 90d data\n')
  console.log('Strategy: positionHistory tries 365d→180d→90d, pnlHistory uses 90d\n')

  const tables = ['trader_snapshots', 'leaderboard_ranks']
  
  for (const table of tables) {
    console.log(`\n📋 Processing: ${table}`)

    const { data: rows, error } = await sb
      .from(table)
      .select('id, source_trader_id, season_id, roi, pnl, win_rate, max_drawdown, trades_count, arena_score')
      .eq('source', 'kucoin')
      .is('win_rate', null)

    if (error) { console.error(`  Error: ${error.message}`); continue }
    if (!rows || rows.length === 0) { console.log('  Nothing to do ✅'); continue }
    console.log(`  ${rows.length} rows missing win_rate`)

    // Group by unique source_trader_id
    const traderMap = new Map()
    for (const row of rows) {
      if (!traderMap.has(row.source_trader_id)) traderMap.set(row.source_trader_id, [])
      traderMap.get(row.source_trader_id).push(row)
    }

    const uniqueIds = [...traderMap.keys()]
    console.log(`  ${uniqueIds.length} unique traders to process`)

    let apiSuccess = 0, apiNoData = 0, dbUpdated = 0
    const cache = new Map()

    for (let i = 0; i < uniqueIds.length; i++) {
      const tid = uniqueIds[i]

      try {
        // Fetch position history (for WR + trade count)
        const posResult = await fetchPositionHistory(tid)
        await sleep(400)

        // Fetch pnl history (for MDD)
        const pnlResult = await fetchPnlHistory(tid)
        await sleep(400)

        let wr = null, tc = null, mdd = null

        if (posResult) {
          wr = calcWinRate(posResult.data)
          tc = posResult.data.length
          apiSuccess++
        } else {
          apiNoData++
        }

        if (pnlResult) {
          mdd = calcMaxDrawdown(pnlResult.data)
        }

        cache.set(tid, { wr, tc, mdd, period: posResult?.period || null })

        if ((i + 1) % 25 === 0 || i + 1 === uniqueIds.length) {
          console.log(`  [${i+1}/${uniqueIds.length}] success=${apiSuccess} noData=${apiNoData}`)
        }
      } catch (e) {
        apiNoData++
        cache.set(tid, { wr: null, tc: null, mdd: null })
      }
    }

    console.log(`\n  API results: ${apiSuccess} had data, ${apiNoData} had no data`)

    // Update DB
    let batchErrors = 0
    for (const [tid, cached] of cache.entries()) {
      if (cached.wr === null && cached.mdd === null && cached.tc === null) continue

      const tRows = traderMap.get(tid)
      for (const row of tRows) {
        const updates = {}
        if (cached.wr !== null && row.win_rate == null) updates.win_rate = cached.wr
        if (cached.mdd !== null && row.max_drawdown == null) updates.max_drawdown = cached.mdd
        if (cached.tc !== null && row.trades_count == null) updates.trades_count = cached.tc

        // Recalc arena_score if we have new data
        if (Object.keys(updates).length > 0 && row.roi != null) {
          const wr = updates.win_rate ?? row.win_rate
          const mdd = updates.max_drawdown ?? row.max_drawdown
          const score = calcScore(row.roi, row.pnl ?? 0, mdd, wr, row.season_id)
          if (score !== null) updates.arena_score = score
        }

        if (Object.keys(updates).length > 0) {
          const { error: ue } = await sb.from(table).update(updates).eq('id', row.id)
          if (!ue) dbUpdated++
          else { batchErrors++; if (batchErrors <= 3) console.error(`  Update error: ${ue.message}`) }
        }
      }
    }

    console.log(`  ✅ DB updated: ${dbUpdated} rows`)
  }

  // Final verification
  console.log('\n📊 Final Verification:')
  for (const table of tables) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'kucoin')
    const { count: noWR } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'kucoin').is('win_rate', null)
    const { count: noMDD } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'kucoin').is('max_drawdown', null)
    const { count: noTC } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'kucoin').is('trades_count', null)
    console.log(`  ${table}: total=${total} wr_null=${noWR} mdd_null=${noMDD} tc_null=${noTC}`)
  }
  console.log('\n✅ Done!')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
