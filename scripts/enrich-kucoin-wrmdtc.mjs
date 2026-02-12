/**
 * Enrich KuCoin traders with WR / MDD / TC data
 * Uses public KuCoin APIs (no browser needed)
 * 
 * Usage: node scripts/enrich-kucoin-wrmdtc.mjs [--dry-run]
 */

import { getSupabaseClient, sleep } from './lib/shared.mjs'

const DRY_RUN = process.argv.includes('--dry-run')
const supabase = getSupabaseClient()

const BASE = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow'
const DELAY_MS = 150

async function fetchJSON(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    })
    if (!r.ok) return null
    const j = await r.json()
    return j.success && j.data ? j.data : null
  } catch { return null }
}

async function main() {
  console.log(`🚀 KuCoin WR/MDD/TC enrichment ${DRY_RUN ? '(DRY RUN)' : ''}`)

  const { data: snapshots, error } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count, season_id')
    .eq('source', 'kucoin')
    .eq('season_id', '90D')

  if (error) { console.error('DB error:', error); return }

  const needEnrich = snapshots.filter(s =>
    s.win_rate == null || s.max_drawdown == null || s.trades_count == null
  )
  console.log(`📊 Total: ${snapshots.length}, Need enrichment: ${needEnrich.length}`)

  let updated = 0, failed = 0, skipped = 0

  for (let i = 0; i < needEnrich.length; i++) {
    const snap = needEnrich[i]
    const id = snap.source_trader_id
    const updates = {}

    // Position history → win_rate + trades_count
    if (snap.win_rate == null || snap.trades_count == null) {
      const positions = await fetchJSON(`${BASE}/positionHistory?lang=en_US&leadConfigId=${id}&period=90d`)
      if (Array.isArray(positions) && positions.length > 0) {
        const wins = positions.filter(p => parseFloat(p.closePnl) > 0).length
        if (snap.win_rate == null) updates.win_rate = parseFloat((wins / positions.length * 100).toFixed(2))
        if (snap.trades_count == null) updates.trades_count = positions.length
      }
      await sleep(DELAY_MS)
    }

    // PNL history → max_drawdown
    if (snap.max_drawdown == null) {
      const pnlData = await fetchJSON(`${BASE}/pnl/history?lang=en_US&leadConfigId=${id}&period=90d`)
      if (Array.isArray(pnlData) && pnlData.length > 0) {
        let peak = -Infinity, maxDD = 0
        for (const d of pnlData) {
          const ratio = parseFloat(d.ratio) || 0
          if (ratio > peak) peak = ratio
          const dd = peak - ratio
          if (dd > maxDD) maxDD = dd
        }
        updates.max_drawdown = parseFloat((maxDD * 100).toFixed(2))
      }
      await sleep(DELAY_MS)
    }

    if (Object.keys(updates).length === 0) {
      skipped++
    } else if (DRY_RUN) {
      console.log(`  [DRY] ${id}: ${JSON.stringify(updates)}`)
      updated++
    } else {
      const { error: ue } = await supabase
        .from('trader_snapshots')
        .update(updates)
        .eq('id', snap.id)
      if (ue) { failed++; console.error(`  ✗ ${id}:`, ue.message) }
      else updated++
    }

    if ((i + 1) % 25 === 0) console.log(`  [${i + 1}/${needEnrich.length}] updated=${updated} skipped=${skipped} failed=${failed}`)
  }

  console.log(`\n✅ Done: updated=${updated}, skipped=${skipped}, failed=${failed}`)
}

main().catch(console.error)
