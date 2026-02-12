/**
 * KuCoin WR Enrichment v2
 * 
 * For traders with win_rate IS NULL:
 * 1. Try positionHistory API → compute WR from closePnl
 * 2. If API returns null/empty → set win_rate=0, trades_count=0
 * 
 * Usage: node scripts/enrich-kucoin-wr-v2.mjs [--dry-run]
 */

import { getSupabaseClient, calculateArenaScore, sleep } from './lib/shared.mjs'

const DRY_RUN = process.argv.includes('--dry-run')
const supabase = getSupabaseClient()
const DELAY_MS = 200

async function fetchPositions(leadConfigId) {
  try {
    const r = await fetch(
      `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?lang=en_US&leadConfigId=${leadConfigId}&period=90d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
    )
    if (!r.ok) return null
    const j = await r.json()
    return j.success ? j.data : null
  } catch { return null }
}

async function main() {
  console.log(`🚀 KuCoin WR enrichment v2 ${DRY_RUN ? '(DRY RUN)' : ''}`)

  const { data: snapshots, error } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, season_id')
    .eq('source', 'kucoin')
    .eq('season_id', '90D')
    .is('win_rate', null)

  if (error) { console.error('DB error:', error); return }
  console.log(`📊 ${snapshots.length} traders with NULL win_rate`)

  let apiHit = 0, apiNull = 0, updated = 0, failed = 0

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]
    const positions = await fetchPositions(snap.source_trader_id)
    
    let winRate, tradesCount
    
    if (Array.isArray(positions) && positions.length > 0) {
      const wins = positions.filter(p => parseFloat(p.closePnl) > 0).length
      winRate = parseFloat((wins / positions.length * 100).toFixed(2))
      tradesCount = positions.length
      apiHit++
    } else {
      // No position data → 0 closed trades
      winRate = 0
      tradesCount = snap.trades_count ?? 0
      apiNull++
    }

    const updates = { win_rate: winRate }
    if (snap.trades_count == null) updates.trades_count = tradesCount

    // Recalculate arena_score
    const { totalScore } = calculateArenaScore(
      snap.roi || 0, snap.pnl, snap.max_drawdown, winRate, '90D'
    )
    updates.arena_score = totalScore

    if (DRY_RUN) {
      if (apiHit <= 3 || apiNull <= 3) console.log(`  [DRY] ${snap.source_trader_id}: WR=${winRate} TC=${tradesCount} score=${totalScore}`)
    } else {
      const { error: ue } = await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
      if (ue) { failed++; console.error(`  ✗ ${snap.source_trader_id}:`, ue.message) }
      else updated++
    }

    if ((i + 1) % 50 === 0 || i === snapshots.length - 1) {
      console.log(`  [${i + 1}/${snapshots.length}] apiHit=${apiHit} apiNull=${apiNull} updated=${updated} failed=${failed}`)
    }

    await sleep(DELAY_MS)
  }

  console.log(`\n✅ Done: updated=${updated}, apiHit=${apiHit}, apiNull=${apiNull}, failed=${failed}`)
}

main().catch(console.error)
