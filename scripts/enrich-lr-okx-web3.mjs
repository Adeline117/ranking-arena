#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks for okx_web3
 * Fetches from OKX ranking API, matches by truncated address
 * Fields: win_rate, trades_count (tx), max_drawdown (from pnlHistory)
 */
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'okx_web3'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'
const PERIOD_MAP = { '7D': '1', '30D': '2', '90D': '3' }

function truncateAddress(addr) {
  if (!addr || addr.length < 11) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function computeMDD(pnlHistory) {
  if (!pnlHistory?.length || pnlHistory.length < 2) return null
  const values = pnlHistory.map(h => parseFloat(h.pnl)).filter(v => !isNaN(v))
  if (values.length < 2) return null
  // Cumulative PnL curve -> drawdown
  let peak = values[0], maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0 && maxDD <= 100 ? parseFloat(maxDD.toFixed(2)) : null
}

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`OKX Web3 — Enrich leaderboard_ranks`)
  console.log(`${'='.repeat(60)}`)

  // Get all rows needing enrichment
  let allRows = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', SOURCE)
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`Need enrichment: ${allRows.length} rows`)
  if (!allRows.length) return

  // Build lookup: truncated_addr|season -> [rows]
  const lookup = new Map()
  for (const r of allRows) {
    const key = `${r.source_trader_id}|${r.season_id}`
    if (!lookup.has(key)) lookup.set(key, [])
    lookup.get(key).push(r)
  }

  let totalUpdated = 0

  for (const [period, periodType] of Object.entries(PERIOD_MAP)) {
    console.log(`\n--- ${period} (periodType=${periodType}) ---`)
    
    // Fetch from multiple chain IDs
    for (const chainId of [501, 1, 56, 137, 43114, 10, 42161, 8453]) {
      const apiTraders = new Map()
      
      for (let start = 0; start < 5000; start += 20) {
        const url = `${BASE}?rankStart=${start}&periodType=${periodType}&rankBy=1&label=all&desc=true&rankEnd=${start + 20}&chainId=${chainId}`
        const json = await fetchJSON(url)
        const infos = json?.data?.rankingInfos || []
        if (infos.length === 0) break
        
        for (const t of infos) {
          const addr = t.walletAddress
          if (!addr) continue
          const truncated = truncateAddress(addr)
          apiTraders.set(truncated, {
            winRate: t.winRate != null ? parseFloat(t.winRate) : null,
            tx: t.tx != null ? parseInt(t.tx) : null,
            mdd: computeMDD(t.pnlHistory),
          })
          // Also store full address
          apiTraders.set(addr, apiTraders.get(truncated))
        }
        
        await sleep(200)
      }

      if (apiTraders.size === 0) continue
      console.log(`  chain=${chainId}: fetched ${apiTraders.size / 2} traders`)

      let updated = 0
      for (const [traderId, rows] of lookup) {
        if (!traderId.endsWith(`|${period}`)) continue
        const tid = traderId.split('|')[0]
        const data = apiTraders.get(tid)
        if (!data) continue

        for (const row of rows) {
          const updates = {}
          if (row.win_rate == null && data.winRate != null) updates.win_rate = data.winRate
          if (row.max_drawdown == null && data.mdd != null) updates.max_drawdown = data.mdd
          if (row.trades_count == null && data.tx != null) updates.trades_count = data.tx

          if (Object.keys(updates).length === 0) continue
          const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
          if (!error) updated++
        }
      }
      totalUpdated += updated
      if (updated > 0) console.log(`    Updated: ${updated}`)
    }
  }

  // Verify
  console.log(`\n${'='.repeat(40)}`)
  console.log(`Total updated: ${totalUpdated}`)
  
  const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: tcNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('trades_count', null)
  console.log(`After: total=${total} wr_null=${wrNull} mdd_null=${mddNull} tc_null=${tcNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
