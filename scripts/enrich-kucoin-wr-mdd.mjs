/**
 * KuCoin WR/MDD Enrichment
 * Fetches win_rate and max_drawdown from KuCoin API for existing DB traders
 * Then recalculates arena_score
 */
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
)

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
  if (!p) return null
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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchKucoinTraderData(traderId) {
  const base = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow'
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Referer': 'https://www.kucoin.com/copytrading',
  }
  
  try {
    const [posRes, pnlRes] = await Promise.all([
      fetch(`${base}/positionHistory?leadConfigId=${traderId}&period=90d&lang=en_US`, { headers }).then(r => r.json()),
      fetch(`${base}/pnl/history?leadConfigId=${traderId}&period=90d&lang=en_US`, { headers }).then(r => r.json()),
    ])
    
    // Win rate from position history
    let winRate = null
    if (posRes.success && Array.isArray(posRes.data) && posRes.data.length > 0) {
      const wins = posRes.data.filter(p => parseFloat(p.closePnl) > 0).length
      winRate = (wins / posRes.data.length) * 100
    }
    
    // MDD from pnl history
    let maxDrawdown = null
    if (pnlRes.success && Array.isArray(pnlRes.data) && pnlRes.data.length >= 2) {
      const equities = pnlRes.data.map(p => 1 + parseFloat(p.ratio || 0))
      let peak = equities[0], maxDD = 0
      for (const eq of equities) {
        if (eq > peak) peak = eq
        if (peak > 0) { const dd = (peak - eq) / peak; if (dd > maxDD) maxDD = dd }
      }
      maxDrawdown = Math.min(maxDD * 100, 100)
    }
    
    // Trades count from position history
    let tradesCount = null
    if (posRes.success && Array.isArray(posRes.data)) {
      tradesCount = posRes.data.length
    }
    
    return { winRate, maxDrawdown, tradesCount }
  } catch (e) {
    console.log(`  Error fetching ${traderId}: ${e.message}`)
    return { winRate: null, maxDrawdown: null, tradesCount: null }
  }
}

async function main() {
  console.log('=== KuCoin WR/MDD Enrichment ===\n')
  
  // Get all kucoin traders missing win_rate
  const { data: traders, error } = await sb
    .from('trader_snapshots')
    .select('id, source_trader_id, season_id, roi, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'kucoin')
    .is('win_rate', null)
  
  if (error) { console.error('Query error:', error); return }
  console.log(`Found ${traders.length} kucoin snapshots missing win_rate`)
  
  // Dedupe by source_trader_id to avoid duplicate API calls
  const traderIds = [...new Set(traders.map(t => t.source_trader_id))]
  console.log(`Unique traders: ${traderIds.length}`)
  
  const dataCache = new Map()
  let enriched = 0, errors = 0
  
  for (let i = 0; i < traderIds.length; i++) {
    const tid = traderIds[i]
    const data = await fetchKucoinTraderData(tid)
    dataCache.set(tid, data)
    
    if (data.winRate !== null || data.maxDrawdown !== null) {
      enriched++
      console.log(`  [${i+1}/${traderIds.length}] ${tid}: WR=${data.winRate?.toFixed(1)}% MDD=${data.maxDrawdown?.toFixed(1)}% TC=${data.tradesCount}`)
    } else {
      console.log(`  [${i+1}/${traderIds.length}] ${tid}: no data from API`)
    }
    
    await sleep(300) // Rate limit
  }
  
  console.log(`\nEnriched ${enriched}/${traderIds.length} traders from API`)
  
  // Update DB
  let updated = 0
  for (const t of traders) {
    const data = dataCache.get(t.source_trader_id)
    if (!data) continue
    
    const updates = {}
    if (data.winRate !== null) updates.win_rate = data.winRate
    if (data.maxDrawdown !== null && data.maxDrawdown > 0.01) updates.max_drawdown = data.maxDrawdown
    if (data.tradesCount !== null && data.tradesCount > 0) updates.trades_count = data.tradesCount
    
    // Recalc arena_score with new data
    const wr = updates.win_rate ?? t.win_rate
    const mdd = updates.max_drawdown ?? t.max_drawdown
    const tc = updates.trades_count ?? t.trades_count
    
    if (t.roi != null) {
      updates.arena_score = calcScore(t.roi, t.pnl ?? 0, mdd, wr, t.season_id)
    }
    
    if (Object.keys(updates).length > 0) {
      const { error: ue } = await sb.from('trader_snapshots').update(updates).eq('id', t.id)
      if (!ue) updated++
      else console.log(`  Error updating ${t.id}: ${ue.message}`)
    }
  }
  
  console.log(`\n✅ Updated ${updated}/${traders.length} kucoin snapshots`)
}

main().catch(console.error)
