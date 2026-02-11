/**
 * Toobit Copy Trading 排行榜数据抓取
 * 
 * API限制: 每次请求只返回6条(可能是地区限制), 但不同dataType返回不同trader
 * 策略: 遍历所有可用dataType(7/30/90/180/365)收集所有unique traders,
 *        然后用每个trader的detail API获取完整数据
 */
import { getSupabaseClient, sleep, calculateArenaScore, getTargetPeriods } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'toobit'
const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.toobit.com',
  'Referer': 'https://www.toobit.com/',
}

// All dataType values that return results
const DATA_TYPES = [7, 30, 90, 180, 365]

async function fetchLeadersList(dataType) {
  const url = `${API_BASE}/leaders-new?pageNo=1&pageSize=50&sortBy=roi&sortType=desc&dataType=${dataType}`
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return []
    const data = await res.json()
    return data?.data?.list || []
  } catch (e) {
    console.error(`  fetchLeadersList(${dataType}) 失败: ${e.message}`)
    return []
  }
}

async function fetchLeaderDetail(leaderUserId, dataType) {
  const url = `${API_BASE}/leader-detail?leaderUserId=${leaderUserId}&dataType=${dataType}`
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    const data = await res.json()
    return data?.data || null
  } catch (e) {
    return null
  }
}

async function main() {
  console.log('=== Toobit Copy Trading 排行榜抓取 ===')
  console.log(`开始: ${new Date().toISOString()}`)
  
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  const periodToDataType = { '7D': 7, '30D': 30, '90D': 90 }
  
  // Step 1: Collect ALL unique trader IDs across all dataTypes
  console.log('\n--- Step 1: 收集所有trader ID ---')
  const allTraderIds = new Map() // id -> {listData, sourceDataType}
  
  for (const dt of DATA_TYPES) {
    const list = await fetchLeadersList(dt)
    console.log(`  dataType=${dt}: ${list.length} traders`)
    for (const item of list) {
      const id = String(item.leaderUserId || '')
      if (id && !allTraderIds.has(id)) {
        allTraderIds.set(id, { listData: item, sourceDataType: dt })
      }
    }
    await sleep(300)
  }
  
  console.log(`  总共 ${allTraderIds.size} 个unique traders`)
  
  if (allTraderIds.size === 0) {
    console.log('❌ 未获取到任何trader数据')
    return
  }
  
  // Step 2: Fetch detail for each trader at each target period's dataType
  console.log('\n--- Step 2: 获取trader详情 ---')
  
  let totalUpserted = 0
  
  for (const period of periods) {
    const dataType = periodToDataType[period] || 90
    console.log(`\n--- ${period} (dataType=${dataType}) ---`)
    
    const tradersForPeriod = []
    
    for (const [id, info] of allTraderIds) {
      // Get detail for this specific period
      const detail = await fetchLeaderDetail(id, dataType)
      await sleep(200)
      
      if (!detail) {
        // Use list data as fallback if from same dataType
        if (info.sourceDataType === dataType) {
          const item = info.listData
          const roi = parseFloat(item.leaderAvgProfitRatio || 0) * 100
          const winRate = parseFloat(item.leaderProfitOrderRatio || 0) * 100
          tradersForPeriod.push({
            id,
            nickname: item.nickname || null,
            avatar: item.avatar || null,
            roi,
            pnl: parseFloat(item.pnl || 0),
            winRate,
            tradeCount: parseInt(item.leaderOrderCount || 0),
            followers: parseInt(item.totalFollowerCount || 0),
          })
        }
        continue
      }
      
      // Parse detail data
      let avatar = detail.avatar || null
      if (avatar === '' || (avatar && (avatar.includes('default') || avatar.includes('placeholder')))) avatar = null
      
      // Get ROI and stats from detail - check multiple field patterns
      const stats = detail.statisticData || detail
      const roi = parseFloat(stats.roiRate || stats.leaderAvgProfitRatio || detail.roiRate || 0) * 100
      const winRate = parseFloat(stats.winRate || stats.lastWeekWinRate || detail.lastWeekWinRate || 0) * 100
      const pnl = parseFloat(stats.pnl || detail.pnl || 0)
      const tradeCount = parseInt(stats.orderCount || stats.leaderOrderCount || detail.orderCount || 0)
      const followers = parseInt(detail.currentFollowerCount || detail.totalFollowerCount || 0)
      
      tradersForPeriod.push({
        id,
        nickname: detail.nickname || info.listData.nickname || null,
        avatar,
        roi,
        pnl,
        winRate,
        tradeCount,
        followers,
        profileUrl: `https://www.toobit.com/en-US/copytrading/trader/info?leaderUserId=${id}`,
      })
    }
    
    console.log(`  ${period}: ${tradersForPeriod.length} traders with data`)
    
    if (tradersForPeriod.length === 0) continue
    
    // Sort by ROI desc
    tradersForPeriod.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    
    // Save trader_sources (only on first period)
    if (period === periods[0]) {
      const sourcesData = tradersForPeriod.map(t => ({
        source: SOURCE,
        source_trader_id: t.id,
        handle: t.nickname,
        avatar_url: t.avatar,
        profile_url: t.profileUrl || `https://www.toobit.com/en-US/copytrading/trader/info?leaderUserId=${t.id}`,
        is_active: true,
        source_kind: 'cex',
        market_type: 'futures',
      }))
      
      for (let i = 0; i < sourcesData.length; i += 30) {
        await supabase.from('trader_sources').upsert(
          sourcesData.slice(i, i + 30),
          { onConflict: 'source,source_trader_id' }
        )
      }
    }
    
    // Save snapshots
    const capturedAt = new Date().toISOString()
    let upserted = 0
    
    for (let idx = 0; idx < tradersForPeriod.length; idx++) {
      const t = tradersForPeriod[idx]
      const scores = calculateArenaScore(t.roi, t.pnl, null, t.winRate, period)
      
      const { error } = await supabase.from('trader_snapshots').upsert({
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
        handle: t.nickname,
        avatar_url: t.avatar,
        captured_at: capturedAt,
      }, { onConflict: 'source,source_trader_id,season_id' })
      
      if (!error) upserted++
    }
    
    totalUpserted += upserted
    console.log(`  写入: ${upserted}/${tradersForPeriod.length}`)
  }
  
  console.log(`\n=== 完成 ===`)
  console.log(`总写入: ${totalUpserted}`)
  console.log(`注意: Toobit API 从此IP只返回少量trader(地区限制), 当前最大约${allTraderIds.size}个unique`)
  console.log(`结束: ${new Date().toISOString()}`)
}

main().catch(e => { console.error(e); process.exit(1) })
