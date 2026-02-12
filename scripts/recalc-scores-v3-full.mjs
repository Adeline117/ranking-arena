/**
 * Recalculate Arena Score V3 for ALL traders (with pagination).
 * The original recalc-scores-v3.ts only gets 1000 per season due to Supabase default limit.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

// Import the V3 scoring module
const { calculateArenaScoreV3, buildPeerContext, detectCompleteness } = await import('../lib/scoring/arena-score-v3.js').catch(async () => {
  // If direct import fails, try tsx compilation
  const mod = await import('../lib/scoring/arena-score-v3.ts')
  return mod
}).catch(() => null)

if (!calculateArenaScoreV3) {
  console.error('Cannot import arena-score-v3 module. Using npx tsx instead.')
  process.exit(1)
}

const SEASONS = ['7D', '30D', '90D']

async function fetchAll(season) {
  const all = []
  let page = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('id, source, source_trader_id, roi, pnl, max_drawdown, win_rate, trades_count, arena_score, alpha, sortino_ratio, calmar_ratio, profit_factor')
      .eq('season_id', season)
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < 1000) break
    page++
  }
  return all
}

async function main() {
  console.log('=== Arena Score V3 Full Recalculation ===\n')
  
  let totalUpdated = 0
  
  for (const season of SEASONS) {
    console.log(`--- ${season} ---`)
    const snapshots = await fetchAll(season)
    console.log(`  Fetched ${snapshots.length} snapshots`)
    
    if (!snapshots.length) continue
    
    const peerData = snapshots.map(s => ({
      roi: s.roi, alpha: s.alpha, max_drawdown: s.max_drawdown,
      sortino_ratio: s.sortino_ratio, calmar_ratio: s.calmar_ratio,
      win_rate: s.win_rate, profit_factor: s.profit_factor,
    }))
    const peers = buildPeerContext(peerData)
    
    let updated = 0, skipped = 0
    const batch = []
    
    for (const snap of snapshots) {
      const input = {
        roi: snap.roi, alpha: snap.alpha, max_drawdown: snap.max_drawdown,
        sortino_ratio: snap.sortino_ratio, calmar_ratio: snap.calmar_ratio,
        win_rate: snap.win_rate, profit_factor: snap.profit_factor,
      }
      const completeness = detectCompleteness(input)
      if (completeness === 'insufficient') { skipped++; continue }
      
      const result = calculateArenaScoreV3(input, peers)
      batch.push({
        id: snap.id,
        arena_score_v3: result.total,
        profitability_score: result.profitability,
        risk_control_score: result.risk_control,
        execution_score: result.execution,
        score_completeness: result.completeness,
        score_penalty: result.penalty,
      })
      updated++
    }
    
    console.log(`  Calculated: ${updated}, Skipped: ${skipped}`)
    
    // Batch update - 20 concurrent to avoid OOM
    for (let i = 0; i < batch.length; i += 20) {
      const chunk = batch.slice(i, i + 20)
      await Promise.all(chunk.map(item =>
        supabase.from('trader_snapshots').update({
          arena_score_v3: item.arena_score_v3,
          profitability_score: item.profitability_score,
          risk_control_score: item.risk_control_score,
          execution_score: item.execution_score,
          score_completeness: item.score_completeness,
          score_penalty: item.score_penalty,
        }).eq('id', item.id)
      ))
      if ((i + 20) % 1000 === 0 || i + 20 >= batch.length) {
        console.log(`  Updated ${Math.min(i + 20, batch.length)}/${batch.length}`)
      }
    }
    
    totalUpdated += updated
    
    const scores = batch.map(b => b.arena_score_v3).sort((a, b) => a - b)
    if (scores.length) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length
      const median = scores[Math.floor(scores.length / 2)]
      const p90 = scores[Math.floor(scores.length * 0.9)]
      console.log(`  Stats: avg=${avg.toFixed(1)}, median=${median.toFixed(1)}, p90=${p90.toFixed(1)}`)
    }
    console.log()
  }
  
  // Also update leaderboard_ranks with V3 scores from snapshots
  console.log('--- Propagating V3 scores to leaderboard_ranks ---')
  // For each season, get latest snapshots with v3 scores and update matching leaderboard_ranks
  for (const season of SEASONS) {
    const { data: scored } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, arena_score_v3, profitability_score, risk_control_score, execution_score, score_completeness, score_penalty')
      .eq('season_id', season)
      .not('arena_score_v3', 'is', null)
      .order('captured_at', { ascending: false })
    
    if (!scored?.length) continue
    
    // Dedupe by source+trader
    const map = new Map()
    for (const s of scored) {
      const k = `${s.source}:${s.source_trader_id}`
      if (!map.has(k)) map.set(k, s)
    }
    
    let propCount = 0
    const entries = Array.from(map.values())
    for (let i = 0; i < entries.length; i += 50) {
      const chunk = entries.slice(i, i + 50)
      await Promise.all(chunk.map(s =>
        supabase.from('leaderboard_ranks').update({
          profitability_score: s.profitability_score,
          risk_control_score: s.risk_control_score,
          execution_score: s.execution_score,
          score_completeness: s.score_completeness,
        }).eq('season_id', season).eq('source', s.source).eq('source_trader_id', s.source_trader_id)
      ))
      propCount += chunk.length
    }
    console.log(`  ${season}: propagated ${propCount} V3 scores to leaderboard_ranks`)
  }
  
  console.log(`\nTotal V3 updated: ${totalUpdated}`)
  console.log('Done!')
}

main().catch(e => { console.error(e); process.exit(1) })
