/**
 * Fix Bitfinex arena_score in trader_snapshots
 * Uses the same V2 scoring as compute-leaderboard-local.mjs
 */
import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function clip(v, min, max) { return Math.max(min, Math.min(max, v)) }
function safeLog1p(x) { return x <= -1 ? 0 : Math.log(1 + x) }

const PARAMS = {
  '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
}
const PNL_PARAMS = {
  '7D': { base: 500, coeff: 0.40 },
  '30D': { base: 2000, coeff: 0.35 },
  '90D': { base: 5000, coeff: 0.30 },
}
const CONF_MULT = { full: 1.0, partial: 0.92, minimal: 0.80 }

function calcScore(roi, pnl, maxDrawdown, winRate, period) {
  const p = PARAMS[period]
  const cappedRoi = Math.min(roi, 10000)
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const intensity = (365 / days) * safeLog1p(cappedRoi / 100)
  const r0 = Math.tanh(p.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(70 * Math.pow(r0, p.roiExponent), 0, 70) : 0

  let pnlScore = 0
  if (pnl > 0) {
    const pp = PNL_PARAMS[period]
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

async function main() {
  // Get all bitfinex snapshots with roi but no arena_score
  const { data: traders, error } = await sb
    .from('trader_snapshots')
    .select('id, source, source_trader_id, season_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'bitfinex')
    .not('roi', 'is', null)
    .is('arena_score', null)

  if (error) { console.error('Query error:', error); return }
  console.log(`Found ${traders.length} bitfinex traders needing arena_score`)

  let updated = 0
  for (const t of traders) {
    let wr = t.win_rate
    if (wr != null && wr <= 1) wr = wr * 100
    if (wr != null) wr = Math.max(0, Math.min(100, wr))

    const score = calcScore(t.roi, t.pnl ?? 0, t.max_drawdown, wr, t.season_id)
    console.log(`  ${t.source_trader_id} [${t.season_id}] roi=${t.roi} wr=${wr} mdd=${t.max_drawdown} → score=${score}`)

    const { error: ue } = await sb
      .from('trader_snapshots')
      .update({ arena_score: score })
      .eq('id', t.id)
    
    if (ue) console.error(`  Error updating ${t.id}:`, ue.message)
    else updated++
  }

  console.log(`\n✅ Updated ${updated}/${traders.length} bitfinex arena_scores`)
}

main().catch(console.error)
