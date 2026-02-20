import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Get the 14 null MDD rows for bitfinex 90D
const { data: nullRows } = await sb.from('leaderboard_ranks')
  .select('id, source_trader_id, season_id, win_rate, max_drawdown, pnl, roi')
  .eq('source', 'bitfinex')
  .eq('season_id', '90D')
  .is('max_drawdown', null)
  .limit(20)

console.log(`Bitfinex 90D null MDD rows: ${nullRows?.length}`)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const INTERVAL_MS = 3 * 3600 * 1000  // 3h (finer granularity)
const COMP_KEY = 'plu:3h:tGLOBAL:USD'

async function fetchRanking(endTs, limit = 500) {
  const url = `https://api-pub.bitfinex.com/v2/rankings/${COMP_KEY}/hist?limit=${limit}&end=${endTs}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

// Try to compute MDD with 3h granularity for 90D
const now = Date.now()
const startTs = now - 90 * 86400 * 1000
const timestamps = []
for (let ts = startTs; ts <= now; ts += INTERVAL_MS) timestamps.push(ts)

console.log(`Will scan ${timestamps.length} snapshots (3h intervals for 90D)`)
console.log(`Sampling a few to check...`)

// Just scan a few samples to test
const targetNames = new Set(nullRows?.map(r => r.source_trader_id.toLowerCase()) || [])
console.log('Target traders:', [...targetNames].slice(0, 5))

// Check 10 snapshots spread over the period
const step = Math.floor(timestamps.length / 10)
const sampleTs = timestamps.filter((_, i) => i % step === 0).slice(0, 10)

const traderSeries = new Map()
for (const ts of sampleTs) {
  const items = await fetchRanking(ts)
  for (const item of items) {
    const name = (item[2] || '').toLowerCase()
    const pnl = item[6]
    if (!targetNames.has(name)) continue
    if (!traderSeries.has(name)) traderSeries.set(name, [])
    traderSeries.get(name).push({ ts, pnl: parseFloat(pnl) })
  }
  process.stdout.write('.')
  await sleep(500)
}
console.log('\nDone sampling')

for (const [name, series] of traderSeries) {
  series.sort((a, b) => a.ts - b.ts)
  const pnls = series.map(s => s.pnl)
  console.log(`  ${name}: ${series.length} points, PNLs: ${pnls.join(', ')}`)
  
  // Compute MDD
  let peak = pnls[0], maxDD = 0
  for (const v of pnls) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = (peak - v) / peak * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  console.log(`  MDD from sample: ${maxDD.toFixed(2)}%`)
}
