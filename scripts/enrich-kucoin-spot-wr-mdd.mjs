#!/usr/bin/env node
/**
 * KuCoin Spot WR/MDD Enrichment
 *
 * Fills win_rate and max_drawdown for source='kucoin_spot' in leaderboard_ranks.
 * Uses the same KuCoin APIs that work for source='kucoin':
 *   - positionHistory (tries 365d→180d→90d) for WR + trades_count
 *   - pnl/history (tries 90d→180d→365d) for MDD calculation
 *
 * Usage: node scripts/enrich-kucoin-spot-wr-mdd.mjs [--dry-run] [--limit=N]
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0')
const SOURCE = 'kucoin_spot'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.kucoin.com/copy-trading',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchPositionHistory(traderId) {
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
    } catch { /* continue */ }
  }
  return null
}

async function fetchPnlHistory(traderId) {
  for (const period of ['90d', '180d', '365d']) {
    try {
      const r = await fetch(
        `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/pnl/history?leadConfigId=${traderId}&period=${period}&lang=en_US`,
        { headers: HEADERS, signal: AbortSignal.timeout(12000) }
      )
      const json = await r.json()
      if (json.data && Array.isArray(json.data) && json.data.length >= 2) {
        const meaningful = json.data.filter(p => {
          const ratio = parseFloat(p.ratio || 0)
          return ratio !== 0 && ratio !== -1
        })
        if (meaningful.length > 0) return { data: json.data, period }
      }
      await sleep(150)
    } catch { /* continue */ }
  }
  return null
}

function calcWinRate(positions) {
  if (!positions || positions.length === 0) return null
  const wins = positions.filter(p => parseFloat(p.closePnl) > 0).length
  return Math.round((wins / positions.length) * 10000) / 100
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
  console.log(`\n🚀 KuCoin Spot WR/MDD Enrichment (source='${SOURCE}')`)
  if (DRY_RUN) console.log('  [DRY RUN]\n')

  // Fetch all leaderboard_ranks rows for kucoin_spot missing WR or MDD
  const query = sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count, roi, pnl')
    .eq('source', SOURCE)
    .or('win_rate.is.null,max_drawdown.is.null')

  const { data: rows, error } = await query
  if (error) { console.error('Query error:', error.message); process.exit(1) }

  const allRows = LIMIT > 0 ? rows.slice(0, LIMIT) : rows
  console.log(`  Found ${allRows.length} leaderboard_ranks rows needing enrichment`)

  // Dedupe by source_trader_id
  const traderMap = new Map()
  for (const row of allRows) {
    if (!traderMap.has(row.source_trader_id)) traderMap.set(row.source_trader_id, [])
    traderMap.get(row.source_trader_id).push(row)
  }

  const uniqueIds = [...traderMap.keys()]
  console.log(`  Unique traders: ${uniqueIds.length}\n`)

  let apiSuccess = 0, apiNoData = 0
  const cache = new Map()

  for (let i = 0; i < uniqueIds.length; i++) {
    const tid = uniqueIds[i]
    try {
      const posResult = await fetchPositionHistory(tid)
      await sleep(350)
      const pnlResult = await fetchPnlHistory(tid)
      await sleep(350)

      const wr = posResult ? calcWinRate(posResult.data) : null
      const tc = posResult ? posResult.data.length : null
      const mdd = pnlResult ? calcMaxDrawdown(pnlResult.data) : null

      cache.set(tid, { wr, tc, mdd })

      if (wr !== null || mdd !== null) {
        apiSuccess++
        if (i < 5 || (i + 1) % 50 === 0) {
          console.log(`  [${i+1}/${uniqueIds.length}] ${tid}: WR=${wr?.toFixed(1)}% MDD=${mdd?.toFixed(1)}% TC=${tc}`)
        }
      } else {
        apiNoData++
        if (i < 5) console.log(`  [${i+1}/${uniqueIds.length}] ${tid}: no data`)
      }

      if ((i + 1) % 100 === 0) {
        console.log(`  Progress: ${i+1}/${uniqueIds.length} | success=${apiSuccess} noData=${apiNoData}`)
      }
    } catch (e) {
      apiNoData++
      cache.set(tid, { wr: null, tc: null, mdd: null })
    }
  }

  console.log(`\n  API results: ${apiSuccess} had data, ${apiNoData} had no data`)

  if (DRY_RUN) {
    console.log('\n  [DRY RUN] Would update DB. Exiting.')
    return
  }

  // Update leaderboard_ranks
  let dbUpdated = 0, dbErrors = 0
  for (const [tid, cached] of cache.entries()) {
    if (cached.wr === null && cached.mdd === null && cached.tc === null) continue

    const tRows = traderMap.get(tid) || []
    for (const row of tRows) {
      const updates = {}
      if (cached.wr !== null && row.win_rate == null) updates.win_rate = cached.wr
      if (cached.mdd !== null && row.max_drawdown == null) updates.max_drawdown = cached.mdd
      if (cached.tc !== null && row.trades_count == null) updates.trades_count = cached.tc

      if (Object.keys(updates).length > 0) {
        const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
        if (!ue) dbUpdated++
        else { dbErrors++; if (dbErrors <= 3) console.error(`  Update error: ${ue.message}`) }
      }
    }
  }

  console.log(`\n✅ Updated ${dbUpdated} leaderboard_ranks rows (errors: ${dbErrors})`)

  // Verification
  const { data: verify } = await sb
    .from('leaderboard_ranks')
    .select('source, season_id')
    .eq('source', SOURCE)
  const total = verify?.length || 0

  const { count: wrNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('win_rate', null)

  const { count: mddNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  console.log(`\n📊 leaderboard_ranks (${SOURCE}): ${total} total`)
  console.log(`   win_rate null: ${wrNull} (${(((total - wrNull) / total) * 100).toFixed(1)}% filled)`)
  console.log(`   max_drawdown null: ${mddNull} (${(((total - mddNull) / total) * 100).toFixed(1)}% filled)`)
}

main().catch(e => { console.error(e); process.exit(1) })
