/**
 * Toobit Copy Trading 排行榜数据抓取
 * 
 * Combines multiple API endpoints to maximize trader count:
 *   1. leaders-new (6 per dataType, ~20 unique across all dataTypes)
 *   2. identity-type-leaders (35+ unique across categories)
 *   3. leader-detail for full stats per period
 *
 * Usage: node scripts/import/import_toobit.mjs [7D|30D|90D|ALL]
 */
import { getSupabaseClient, sleep, calculateArenaScore, getTargetPeriods } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'toobit'
const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Origin': 'https://www.toobit.com',
  'Referer': 'https://www.toobit.com/',
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    console.error(`  fetch failed: ${e.message}`)
    return null
  }
}

async function collectAllTraderIds() {
  const traders = new Map() // id -> basic info

  // Source 1: leaders-new across all dataTypes
  for (const dt of [7, 30, 90, 180, 365]) {
    for (const sort of ['roi', 'pnl', 'copiers', 'winRate']) {
      const data = await fetchJson(`${API_BASE}/leaders-new?pageNo=1&pageSize=50&sortBy=${sort}&sortType=desc&dataType=${dt}`)
      const list = data?.data?.list || []
      for (const item of list) {
        const id = String(item.leaderUserId || '')
        if (id && !traders.has(id)) {
          traders.set(id, {
            nickname: item.nickname || null,
            avatar: item.avatar || null,
          })
        }
      }
      await sleep(200)
    }
  }
  console.log(`  leaders-new: ${traders.size} unique`)

  // Source 2: identity-type-leaders
  const identityData = await fetchJson(`${API_BASE}/identity-type-leaders`)
  if (identityData?.data) {
    for (const key of Object.keys(identityData.data)) {
      const items = identityData.data[key]
      if (Array.isArray(items)) {
        for (const item of items) {
          const id = String(item.leaderUserId || '')
          if (id && !traders.has(id)) {
            traders.set(id, {
              nickname: item.nickname || null,
              avatar: item.avatar || null,
            })
          }
        }
      }
    }
  }
  console.log(`  + identity-type-leaders: ${traders.size} unique total`)

  // Source 3: Also try /api/v1 path
  for (const dt of [7, 30, 90]) {
    const data = await fetchJson(`https://bapi.toobit.com/api/v1/copy-trading/leaders-new?pageNo=1&pageSize=50&sortBy=roi&sortType=desc&dataType=${dt}`)
    const list = data?.data?.list || []
    for (const item of list) {
      const id = String(item.leaderUserId || '')
      if (id && !traders.has(id)) {
        traders.set(id, { nickname: item.nickname || null, avatar: item.avatar || null })
      }
    }
    await sleep(200)
  }
  console.log(`  + api/v1 path: ${traders.size} unique total`)

  return traders
}

async function main() {
  console.log('=== Toobit Copy Trading 排行榜抓取 ===')
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  const periodToDataType = { '7D': 7, '30D': 30, '90D': 90 }

  // Step 1: Collect all trader IDs
  console.log('\n--- Step 1: 收集所有trader ID ---')
  const allTraders = await collectAllTraderIds()
  console.log(`  总共 ${allTraders.size} 个unique traders`)

  if (allTraders.size === 0) {
    console.log('❌ 未获取到任何trader数据')
    return
  }

  // Step 2: For each period, fetch details and save
  let totalSaved = 0

  for (const period of periods) {
    const dataType = periodToDataType[period]
    console.log(`\n--- ${period} (dataType=${dataType}) ---`)

    const tradersForPeriod = []

    for (const [id, info] of allTraders) {
      const detail = await fetchJson(`${API_BASE}/leader-detail?leaderUserId=${id}&dataType=${dataType}`)
      await sleep(150)

      if (!detail?.data) continue
      const d = detail.data
      const stats = d.statisticData || d

      const roi = parseFloat(stats.roiRate || stats.leaderAvgProfitRatio || d.leaderAvgProfitRatio || 0) * 100
      const winRate = parseFloat(stats.winRate || stats.lastWeekWinRate || d.lastWeekWinRate || d.leaderProfitOrderRatio || 0) * 100
      const pnl = parseFloat(stats.pnl || d.pnl || 0)
      const tradeCount = parseInt(stats.orderCount || stats.leaderOrderCount || d.leaderOrderCount || d.orderCount || 0)
      const followers = parseInt(d.currentFollowerCount || d.totalFollowerCount || 0)
      let avatar = d.avatar || info.avatar || null
      if (avatar === '' || (avatar && avatar.includes('default'))) avatar = null

      tradersForPeriod.push({
        id,
        nickname: d.nickname || info.nickname || null,
        avatar,
        roi,
        pnl,
        winRate,
        tradeCount,
        followers,
      })
    }

    console.log(`  ${period}: ${tradersForPeriod.length} traders with data`)
    if (tradersForPeriod.length === 0) continue

    tradersForPeriod.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    const capturedAt = new Date().toISOString()

    // Upsert trader_sources
    const sourcesData = tradersForPeriod.map(t => ({
      source: SOURCE,
      source_trader_id: t.id,
      handle: t.nickname,
      avatar_url: t.avatar,
      profile_url: `https://www.toobit.com/en-US/copytrading/trader/info?leaderUserId=${t.id}`,
      is_active: true,
    }))
    for (let i = 0; i < sourcesData.length; i += 30) {
      await supabase.from('trader_sources').upsert(sourcesData.slice(i, i + 30), { onConflict: 'source,source_trader_id' })
    }

    // Upsert snapshots
    let saved = 0
    const snapshots = tradersForPeriod.map((t, idx) => {
      const scores = calculateArenaScore(t.roi, t.pnl, null, t.winRate, period)
      return {
        source: SOURCE,
        source_trader_id: t.id,
        season_id: period,
        rank: idx + 1,
        roi: t.roi,
        pnl: t.pnl,
        win_rate: t.winRate,
        max_drawdown: null,
        trades_count: t.tradeCount,
        followers: t.followers,
        arena_score: scores.totalScore,
        captured_at: capturedAt,
      }
    })

    for (let i = 0; i < snapshots.length; i += 30) {
      const batch = snapshots.slice(i, i + 30)
      const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved += batch.length
      else console.log(`  ⚠ upsert error: ${error.message}`)
    }

    totalSaved += saved
    console.log(`  ✅ 写入: ${saved}/${tradersForPeriod.length}`)
  }

  console.log(`\n=== 完成 === 总写入: ${totalSaved}`)
}

main().catch(e => { console.error(e); process.exit(1) })
