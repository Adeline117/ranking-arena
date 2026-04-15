#!/usr/bin/env node
/**
 * One-off: recalculate arena_score in leaderboard_ranks.
 * Removes Wilson 5-signal penalty, applies corrected 2-signal confidence.
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { readFileSync } from 'fs'

try {
  const envContent = readFileSync('.env.local', 'utf8')
  const parsed = dotenv.parse(envContent)
  for (const [k, v] of Object.entries(parsed)) process.env[k] = v
} catch { /* ignore */ }

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  const PAGE = 1000
  let offset = 0
  let total = 0
  let updated = 0
  let errors = 0

  while (true) {
    const { data, error } = await db.from('leaderboard_ranks')
      .select('id, arena_score, profitability_score, risk_control_score, roi, pnl')
      .range(offset, offset + PAGE - 1)

    if (error) { console.error('Fetch error:', error); break }
    if (!data || data.length === 0) break

    // Build updates
    const updates = []
    for (const row of data) {
      const returnScore = row.profitability_score ?? 0
      const pnlScore = row.risk_control_score ?? 0
      const rawSum = returnScore + pnlScore

      const hasRoi = row.roi != null
      const hasPnl = row.pnl != null && Number(row.pnl) > 0
      const conf = (hasRoi && hasPnl) ? 1.0 : hasRoi ? 0.85 : 0.50

      const newScore = Math.round(Math.max(0, Math.min(100, rawSum * conf)) * 100) / 100

      if (Math.abs((row.arena_score ?? 0) - newScore) > 0.005) {
        updates.push({ id: row.id, newScore })
      }
    }

    // Batch update: 50 concurrent updates at a time
    for (let i = 0; i < updates.length; i += 50) {
      const batch = updates.slice(i, i + 50)
      const results = await Promise.all(
        batch.map(u => db.from('leaderboard_ranks').update({ arena_score: u.newScore }).eq('id', u.id))
      )
      for (const r of results) {
        if (r.error) { errors++; if (errors <= 3) console.error('Update err:', r.error) }
      }
    }

    updated += updates.length
    total += data.length
    offset += PAGE
    process.stdout.write(`\r${total} processed, ${updated} updated, ${errors} errors`)

    if (data.length < PAGE) break
  }

  console.log(`\nDone: ${total} rows, ${updated} updated, ${errors} errors`)

  // Verify
  const { data: top } = await db.from('leaderboard_ranks')
    .select('source, handle, arena_score, profitability_score, risk_control_score, roi, pnl, season_id')
    .eq('season_id', '90D')
    .order('arena_score', { ascending: false })
    .limit(15)

  if (top) {
    console.log('\n=== Top 15 (90D) ===')
    top.forEach((r, i) => {
      const sum = ((r.profitability_score || 0) + (r.risk_control_score || 0)).toFixed(2)
      const match = Math.abs(r.arena_score - Number(sum)) < 0.02 ? 'OK' : `DIFF=${(r.arena_score - Number(sum)).toFixed(2)}`
      console.log(`#${i + 1} | score=${r.arena_score} | ${r.profitability_score}+${r.risk_control_score}=${sum} ${match} | ROI=${Number(r.roi).toFixed(1)}% PnL=$${Number(r.pnl || 0).toFixed(0)} | ${r.handle || r.source}`)
    })
  }

  for (const t of [60, 70, 80, 90]) {
    const { count } = await db.from('leaderboard_ranks').select('id', { count: 'exact', head: true }).eq('season_id', '90D').gte('arena_score', t)
    console.log(`90D >= ${t}: ${count}`)
  }
}

main().catch(console.error)
