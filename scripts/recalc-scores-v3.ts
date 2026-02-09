#!/usr/bin/env npx tsx
/**
 * Recalculate Arena Score V3 for all traders using percentile-based scoring.
 *
 * Usage: npx tsx scripts/recalc-scores-v3.ts [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import {
  calculateArenaScoreV3,
  buildPeerContext,
  detectCompleteness,
  type ArenaScoreV3Input,
} from '../lib/scoring/arena-score-v3'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const DRY_RUN = process.argv.includes('--dry-run')

const SEASONS = ['7D', '30D', '90D'] as const

async function main() {
  console.log(`=== Arena Score V3 Recalculation ${DRY_RUN ? '(DRY RUN)' : ''} ===`)
  console.log(`Started: ${new Date().toISOString()}\n`)

  for (const season of SEASONS) {
    console.log(`--- Processing ${season} ---`)

    // 1. Fetch all snapshots for this season (columns already have V3 fields)
    const { data: snapshots, error } = await supabase
      .from('trader_snapshots')
      .select('id, source, source_trader_id, roi, pnl, max_drawdown, win_rate, trades_count, arena_score, alpha, sortino_ratio, calmar_ratio, profit_factor')
      .eq('season_id', season)

    if (error) {
      console.error(`  Error fetching ${season}:`, error.message)
      continue
    }

    if (!snapshots || snapshots.length === 0) {
      console.log(`  No snapshots for ${season}`)
      continue
    }

    console.log(`  Found ${snapshots.length} snapshots`)

    // 2. Build peer context from all snapshots
    const peerData = snapshots.map(s => ({
      roi: s.roi,
      alpha: s.alpha,
      max_drawdown: s.max_drawdown,
      sortino_ratio: s.sortino_ratio,
      calmar_ratio: s.calmar_ratio,
      win_rate: s.win_rate,
      profit_factor: s.profit_factor,
    }))

    const peers = buildPeerContext(peerData)
    console.log(`  Peer context: ${peers.roi_values.length} ROI, ${peers.drawdown_values.length} MDD, ${peers.winrate_values.length} WR`)

    // 3. Calculate scores
    let updated = 0
    let skipped = 0
    const batch: { id: string; arena_score: number; score_confidence: string; profitability: number; risk_control: number; execution: number; penalty: number }[] = []

    for (const snap of snapshots) {
      const input: ArenaScoreV3Input = {
        roi: snap.roi,
        alpha: snap.alpha,
        max_drawdown: snap.max_drawdown,
        sortino_ratio: snap.sortino_ratio,
        calmar_ratio: snap.calmar_ratio,
        win_rate: snap.win_rate,
        profit_factor: snap.profit_factor,
      }

      const completeness = detectCompleteness(input)
      if (completeness === 'insufficient') {
        skipped++
        continue
      }

      const result = calculateArenaScoreV3(input, peers)
      batch.push({
        id: snap.id,
        arena_score: result.total,
        score_confidence: result.completeness,
        profitability: result.profitability,
        risk_control: result.risk_control,
        execution: result.execution,
        penalty: result.penalty,
      })
      updated++
    }

    console.log(`  Calculated: ${updated}, Skipped (insufficient): ${skipped}`)

    // 5. Batch update
    if (!DRY_RUN && batch.length > 0) {
      // Update in chunks of 500
      const CHUNK = 500
      for (let i = 0; i < batch.length; i += CHUNK) {
        const chunk = batch.slice(i, i + CHUNK)
        // Use individual updates since upsert on non-PK doesn't work well
        for (const item of chunk) {
          const { error: upErr } = await supabase
            .from('trader_snapshots')
            .update({
              arena_score_v3: item.arena_score,
              profitability_score: item.profitability,
              risk_control_score: item.risk_control,
              execution_score: item.execution,
              score_completeness: item.score_confidence,
              score_penalty: item.penalty,
            })
            .eq('id', item.id)

          if (upErr) {
            console.error(`  Error updating ${item.id}:`, upErr.message)
          }
        }
        console.log(`  Updated ${Math.min(i + CHUNK, batch.length)}/${batch.length}`)
      }
    }

    // Stats
    const scores = batch.map(b => b.arena_score)
    if (scores.length > 0) {
      scores.sort((a, b) => a - b)
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length
      const median = scores[Math.floor(scores.length / 2)]
      const p90 = scores[Math.floor(scores.length * 0.9)]
      const byConf = batch.reduce((acc, b) => {
        acc[b.score_confidence] = (acc[b.score_confidence] || 0) + 1
        return acc
      }, {} as Record<string, number>)
      console.log(`  Score stats: avg=${avg.toFixed(1)}, median=${median.toFixed(1)}, p90=${p90.toFixed(1)}`)
      console.log(`  Confidence: ${JSON.stringify(byConf)}`)
    }
    console.log()
  }

  console.log(`Done: ${new Date().toISOString()}`)
}

main().catch(console.error)
