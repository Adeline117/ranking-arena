#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks for gains
 * Uses gains.trade personal stats API
 * Fields: win_rate, trades_count
 * Note: max_drawdown not available from this API
 */
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gains'
const CHAIN_IDS = [42161, 137] // Arbitrum, Polygon

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gains — Enrich leaderboard_ranks`)
  console.log(`${'='.repeat(60)}`)

  let allRows = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', SOURCE)
      .or('win_rate.is.null,trades_count.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`Need enrichment: ${allRows.length} rows`)
  if (!allRows.length) return

  // Group by trader address
  const byAddr = new Map()
  for (const r of allRows) {
    if (!byAddr.has(r.source_trader_id)) byAddr.set(r.source_trader_id, [])
    byAddr.get(r.source_trader_id).push(r)
  }

  const addresses = [...byAddr.keys()]
  console.log(`Unique addresses: ${addresses.length}`)

  let updated = 0, failed = 0

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i]
    const rows = byAddr.get(addr)

    if ((i + 1) % 50 === 0) console.log(`  [${i + 1}/${addresses.length}] updated=${updated} failed=${failed}`)

    let stats = null
    for (const chainId of CHAIN_IDS) {
      stats = await fetchJSON(`https://backend-global.gains.trade/api/personal-trading-history/${addr}/stats?chainId=${chainId}`)
      if (stats && !stats.error && stats.totalTrades > 0) break
      stats = null
    }

    if (!stats) { failed++; await sleep(300); continue }

    const winRate = stats.winRate != null ? parseFloat(parseFloat(stats.winRate).toFixed(2)) : null
    const totalTrades = stats.totalTrades != null ? parseInt(stats.totalTrades) : null

    for (const row of rows) {
      const updates = {}
      if (row.win_rate == null && winRate != null && !isNaN(winRate)) updates.win_rate = winRate
      if (row.trades_count == null && totalTrades != null) updates.trades_count = totalTrades
      if (Object.keys(updates).length === 0) continue

      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) updated++
      else failed++
    }

    await sleep(500)
  }

  console.log(`\n✅ Gains: ${updated} updated, ${failed} failed`)

  // Verify
  const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: tcNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('trades_count', null)
  console.log(`After: total=${total} wr_null=${wrNull} mdd_null=${mddNull} tc_null=${tcNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
