/**
 * Aevo DEX 排行榜数据抓取
 * 
 * API: https://api.aevo.xyz/leaderboard?limit=100
 * 返回 daily/weekly/monthly/all_time 排行榜
 * 字段: username, pnl, options_volume, perp_volume, ranking
 * 
 * 映射: weekly→7D, monthly→30D, all_time→90D
 * 
 * Usage: node scripts/import/import_aevo.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'aevo'
const API_URL = 'https://api.aevo.xyz/leaderboard?limit=100'

const PERIOD_MAP = {
  '7D': 'weekly',
  '30D': 'monthly',
  '90D': 'all_time',
}

async function fetchLeaderboard() {
  console.log('  📊 Fetching Aevo leaderboard...')
  const res = await fetch(API_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  })
  if (!res.ok) throw new Error(`Aevo API error: ${res.status}`)
  const data = await res.json()
  return data.leaderboard
}

async function processAndSave(entries, period) {
  if (!entries || entries.length === 0) {
    console.log(`  ⚠ No data for ${period}`)
    return 0
  }

  const capturedAt = new Date().toISOString()

  // Upsert trader_sources
  const sourcesData = entries.map(t => ({
    source: SOURCE,
    source_type: 'defi',
    source_trader_id: t.username.toLowerCase(),
    handle: t.username,
    profile_url: `https://app.aevo.xyz/portfolio/${t.username}`,
    is_active: true,
  }))

  await supabase.from('trader_sources').upsert(sourcesData, {
    onConflict: 'source,source_trader_id',
  })

  // Compute ROI estimate from PnL and volume
  const snapshotsData = entries.map((t, idx) => {
    const totalVolume = (t.options_volume || 0) + (t.perp_volume || 0)
    // Estimate ROI: PnL / (volume / avg_leverage~10) as rough capital estimate
    const estimatedCapital = totalVolume > 0 ? totalVolume / 10 : 0
    const roi = estimatedCapital > 0 ? (t.pnl / estimatedCapital) * 100 : null

    return {
      source: SOURCE,
      source_trader_id: t.username.toLowerCase(),
      season_id: period,
      rank: t.ranking || idx + 1,
      roi,
      pnl: t.pnl || 0,
      win_rate: null,
      max_drawdown: null,
      followers: 0,
      trades_count: null,
      arena_score: calculateArenaScore(roi || 0, t.pnl || 0, null, null, period).totalScore,
      captured_at: capturedAt,
    }
  })

  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
    onConflict: 'source,source_trader_id,season_id',
  })

  if (error) {
    console.log(`  ⚠ Batch save failed: ${error.message}, trying one by one...`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, {
        onConflict: 'source,source_trader_id,season_id',
      })
      if (!e) saved++
    }
    console.log(`  逐条保存: ${saved}/${snapshotsData.length}`)
    return saved
  }

  console.log(`  ✓ ${period}: saved ${entries.length} traders`)
  return entries.length
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const targetPeriods = arg === 'ALL' || !arg ? ['7D', '30D', '90D'] :
    ['7D', '30D', '90D'].includes(arg) ? [arg] : ['7D', '30D', '90D']

  console.log('Aevo DEX 排行榜抓取')
  console.log('目标周期:', targetPeriods.join(', '))

  const leaderboard = await fetchLeaderboard()

  for (const period of targetPeriods) {
    const apiKey = PERIOD_MAP[period]
    const entries = leaderboard[apiKey] || []
    console.log(`\n=== ${period} (${apiKey}): ${entries.length} entries ===`)

    if (entries.length > 0) {
      console.log(`  TOP 3:`)
      entries.slice(0, 3).forEach((t, i) => {
        console.log(`    ${i + 1}. ${t.username}: PnL $${t.pnl?.toFixed(2)}, Vol $${((t.options_volume || 0) + (t.perp_volume || 0)).toFixed(0)}`)
      })
    }

    await processAndSave(entries, period)
    await sleep(1000)
  }

  console.log('\n✅ Aevo 完成')
}

main().catch(console.error)
