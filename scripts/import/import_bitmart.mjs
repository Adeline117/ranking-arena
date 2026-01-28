/**
 * BitMart 合约跟单排行榜数据抓取
 *
 * 用法: node scripts/import/import_bitmart.mjs [7D|30D|90D|ALL]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing env'); process.exit(1) }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'bitmart'
const TARGET_COUNT = 200

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = { '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
                   '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
                   '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 } }[period] || { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 }
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const wr = winRate !== null ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(85 * Math.pow(r0, params.roiExponent), 0, 85) : 0
  const drawdownScore = maxDrawdown !== null ? clip(8 * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.bitmart.com',
  'Referer': 'https://www.bitmart.com/copy-trading',
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 BitMart ${period} ===`)
  const periodMap = { '7D': '7', '30D': '30', '90D': '90' }
  const periodVal = periodMap[period] || '30'

  const traders = []

  try {
    // 尝试 BitMart copy trading API
    const urls = [
      `https://www.bitmart.com/api/copy-trading/v1/public/rank?period=${periodVal}&limit=${TARGET_COUNT}&sort=roi`,
      `https://api-cloud.bitmart.com/copy-trading/v1/public/trader-rank?days=${periodVal}&limit=${TARGET_COUNT}`,
    ]

    for (const url of urls) {
      try {
        const response = await fetch(url, { method: 'GET', headers: HEADERS })
        if (!response.ok) continue

        const json = await response.json()
        const list = json?.data?.list || json?.data?.traders || json?.data || []

        if (Array.isArray(list) && list.length > 0) {
          console.log(`  从 API 获取到 ${list.length} 条`)
          for (const t of list) {
            traders.push({
              traderId: String(t.uid || t.trader_id || t.id || ''),
              nickname: t.nickname || t.trader_name || t.name || 'Unknown',
              roi: parseFloat(t.roi || t.profit_rate || 0) * (Math.abs(t.roi || 0) > 10 ? 1 : 100),
              pnl: parseFloat(t.pnl || t.total_pnl || 0),
              winRate: t.win_rate != null ? parseFloat(t.win_rate) : null,
              maxDrawdown: t.max_drawdown != null ? parseFloat(t.max_drawdown) : null,
              followers: parseInt(t.followers || t.follower_count || 0),
              avatarUrl: t.avatar || t.head_url || null,
            })
          }
          break
        }
      } catch (e) { continue }
    }

    if (traders.length === 0) {
      console.log('  API 无数据，可能需要 Puppeteer 抓取')
    }

    return traders.filter(t => t.traderId)
  } catch (e) {
    console.error('Error:', e.message)
    return []
  }
}

async function saveTraders(traders, period) {
  if (traders.length === 0) return 0
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const topTraders = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()

  await supabase.from('trader_sources').upsert(
    topTraders.map(t => ({
      source: SOURCE,
      source_type: 'leaderboard',
      source_trader_id: t.traderId,
      handle: t.nickname,
      profile_url: `https://www.bitmart.com/copy-trading/trader/${t.traderId}`,
      is_active: true
    })),
    { onConflict: 'source,source_trader_id' }
  )

  const { error } = await supabase.from('trader_snapshots').insert(
    topTraders.map((t, idx) => ({
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.winRate,
      max_drawdown: t.maxDrawdown,
      followers: t.followers,
      arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period),
      captured_at: capturedAt
    }))
  )

  console.log(error ? `  保存失败: ${error.message}` : `  保存成功: ${topTraders.length}`)
  return error ? 0 : topTraders.length
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const targetPeriods = arg === 'ALL' ? ['7D', '30D', '90D'] :
    arg && ['7D', '30D', '90D'].includes(arg) ? [arg] : ['7D', '30D', '90D']

  console.log('BitMart 数据抓取开始...')
  for (const period of targetPeriods) {
    const traders = await fetchLeaderboardData(period)
    if (traders.length > 0) await saveTraders(traders, period)
    await new Promise(r => setTimeout(r, 3000))
  }
  console.log('\n✅ BitMart 完成')
}

main()
