/**
 * KuCoin WR/MDD Enrichment - 90D only, fast
 */
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
)

function clip(v, min, max) { return Math.max(min, Math.min(max, v)) }
function safeLog1p(x) { return x <= -1 ? 0 : Math.log(1 + x) }
const PARAMS = { '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 } }
const PNL_PARAMS = { '90D': { base: 5000, coeff: 0.30 } }
const CONF_MULT = { full: 1.0, partial: 0.92, minimal: 0.80 }

function calcScore(roi, pnl, mdd, wr) {
  const p = PARAMS['90D'], pp = PNL_PARAMS['90D']
  const cappedRoi = Math.min(roi, 10000)
  const intensity = (365 / 90) * safeLog1p(cappedRoi / 100)
  const r0 = Math.tanh(p.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(70 * Math.pow(r0, p.roiExponent), 0, 70) : 0
  let pnlScore = 0
  if (pnl > 0) { const la = 1 + pnl / pp.base; if (la > 0) pnlScore = clip(15 * Math.tanh(pp.coeff * Math.log(la)), 0, 15) }
  const effMdd = (!mdd || mdd === 0) ? -20 : mdd
  const normMdd = Math.abs(effMdd) <= 1 ? Math.abs(effMdd) * 100 : Math.abs(effMdd)
  const drawdownScore = clip(8 * clip(1 - normMdd / p.mddThreshold, 0, 1), 0, 8)
  const effWr = (wr == null) ? 50 : wr
  const normWr = (effWr <= 1 && effWr >= 0) ? effWr * 100 : effWr
  const stabilityScore = clip(7 * clip((normWr - 45) / (p.winRateCap - 45), 0, 1), 0, 7)
  const hasMdd = mdd != null && mdd !== 0, hasWr = wr != null && wr !== 0
  const conf = (hasMdd && hasWr) ? 'full' : (hasMdd || hasWr) ? 'partial' : 'minimal'
  return Math.round(clip((returnScore + pnlScore + drawdownScore + stabilityScore) * CONF_MULT[conf], 0, 100) * 100) / 100
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchData(traderId) {
  const base = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow'
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.kucoin.com/copytrading' }
  try {
    const [posRes, pnlRes] = await Promise.all([
      fetch(`${base}/positionHistory?leadConfigId=${traderId}&period=90d&lang=en_US`, { headers, signal: AbortSignal.timeout(8000) }).then(r => r.json()),
      fetch(`${base}/pnl/history?leadConfigId=${traderId}&period=90d&lang=en_US`, { headers, signal: AbortSignal.timeout(8000) }).then(r => r.json()),
    ])
    let wr = null, tc = null
    if (posRes.success && Array.isArray(posRes.data) && posRes.data.length > 0) {
      tc = posRes.data.length
      wr = (posRes.data.filter(p => parseFloat(p.closePnl) > 0).length / tc) * 100
    }
    let mdd = null
    if (pnlRes.success && Array.isArray(pnlRes.data) && pnlRes.data.length >= 2) {
      const eq = pnlRes.data.map(p => 1 + parseFloat(p.ratio || 0))
      let peak = eq[0], maxDD = 0
      for (const v of eq) { if (v > peak) peak = v; if (peak > 0) { const dd = (peak - v) / peak; if (dd > maxDD) maxDD = dd } }
      mdd = Math.min(maxDD * 100, 100)
    }
    return { wr, mdd, tc }
  } catch { return { wr: null, mdd: null, tc: null } }
}

async function main() {
  const { data: traders } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'kucoin').eq('season_id', '90D').is('win_rate', null)
  
  console.log(`KuCoin 90D missing WR: ${traders?.length || 0}`)
  if (!traders?.length) return

  const ids = [...new Set(traders.map(t => t.source_trader_id))]
  const cache = new Map()
  let enriched = 0

  for (let i = 0; i < ids.length; i++) {
    const d = await fetchData(ids[i])
    cache.set(ids[i], d)
    if (d.wr !== null) enriched++
    if ((i+1) % 20 === 0) console.log(`  API: ${i+1}/${ids.length} (enriched: ${enriched})`)
    await sleep(200)
  }
  console.log(`API done: ${enriched}/${ids.length} enriched`)

  let updated = 0
  for (const t of traders) {
    const d = cache.get(t.source_trader_id)
    if (!d) continue
    const upd = {}
    if (d.wr !== null) upd.win_rate = d.wr
    if (d.mdd !== null && d.mdd > 0.01) upd.max_drawdown = d.mdd
    if (d.tc !== null && d.tc > 0) upd.trades_count = d.tc
    const wr = upd.win_rate ?? t.win_rate
    const mdd = upd.max_drawdown ?? t.max_drawdown
    if (t.roi != null) upd.arena_score = calcScore(t.roi, t.pnl ?? 0, mdd, wr)
    if (Object.keys(upd).length > 0) {
      const { error } = await sb.from('trader_snapshots').update(upd).eq('id', t.id)
      if (!error) updated++
    }
  }
  console.log(`✅ Updated ${updated}/${traders.length} kucoin 90D snapshots`)
}

main().catch(console.error)
