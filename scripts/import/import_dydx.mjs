/**
 * dYdX DEX 排行榜数据抓取
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing env'); process.exit(1) }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'dydx'
const TARGET_COUNT = 100

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 }
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const wr = winRate !== null ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(85 * Math.pow(r0, params.roiExponent), 0, 85) : 0
  const drawdownScore = maxDrawdown !== null ? clip(8 * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

async function fetchLeaderboardData(period) {
  console.log('\n=== 抓取 dYdX ' + period + ' ===')
  
  // dYdX v4 API
  const periodMap = { '7D': 'WEEKLY', '30D': 'MONTHLY', '90D': 'YEARLY' }
  
  try {
    // dYdX v4 leaderboard API
    const response = await fetch('https://indexer.dydx.trade/v4/leaderboard/pnl?period=' + (periodMap[period] || 'MONTHLY') + '&limit=100', {
      headers: { 'Accept': 'application/json' }
    })
    
    if (!response.ok) {
      console.log('  API 响应错误: ' + response.status)
      return []
    }
    
    const data = await response.json()
    const traders = data.leaderboard || data || []
    console.log('  获取到 ' + traders.length + ' 条')
    
    return traders.map(t => ({
      traderId: t.address || t.subaccountId || '',
      nickname: t.address ? t.address.slice(0,6) + '...' + t.address.slice(-4) : 'Unknown',
      roi: parseFloat(t.pnlPercent || t.percentPnl || 0) * 100,
      pnl: parseFloat(t.pnl || 0),
      winRate: null, maxDrawdown: null, followers: 0
    }))
  } catch (e) { 
    console.error('Error:', e.message)
    return [] 
  }
}

async function saveTraders(traders, period) {
  if (traders.length === 0) return 0
  traders.sort((a, b) => b.roi - a.roi)
  const top100 = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()
  
  await supabase.from('trader_sources').upsert(
    top100.map(t => ({ source: SOURCE, source_type: 'leaderboard', source_trader_id: t.traderId, handle: t.nickname, profile_url: 'https://dydx.trade/portfolio/' + t.traderId, is_active: true })),
    { onConflict: 'source,source_trader_id' }
  )
  
  const { error } = await supabase.from('trader_snapshots').insert(
    top100.map((t, idx) => ({ source: SOURCE, source_trader_id: t.traderId, season_id: period, rank: idx + 1, roi: t.roi, pnl: t.pnl, win_rate: t.winRate, max_drawdown: t.maxDrawdown, followers: t.followers, arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period), captured_at: capturedAt }))
  )
  console.log(error ? '  保存失败: ' + error.message : '  保存成功: ' + top100.length)
  return error ? 0 : top100.length
}

async function main() {
  for (const period of ['30D', '90D']) {
    const traders = await fetchLeaderboardData(period)
    if (traders.length > 0) await saveTraders(traders, period)
    await new Promise(r => setTimeout(r, 2000))
  }
  console.log('\n✅ dYdX 完成')
}

main()
