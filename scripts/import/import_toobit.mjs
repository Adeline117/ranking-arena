/**
 * Toobit Copy Trading 排行榜数据抓取
 * API: bapi.toobit.com/bapi/v1/copy-trading/leaders-new
 */
import { getSupabaseClient, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'toobit'
const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading/leaders-new'
const PERIODS = [
  { param: '7D', dataType: 7, season: '7d' },
  { param: '30D', dataType: 30, season: '30d' },
  { param: '90D', dataType: 90, season: '90d' },
]

async function fetchPage(dataType, page, size = 50) {
  const url = `${API_BASE}?pageNo=${page}&pageSize=${size}&sortBy=roi&sortType=desc&dataType=${dataType}`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.toobit.com',
        'Referer': 'https://www.toobit.com/',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return data?.data?.list || []
  } catch(e) {
    console.error(`  请求失败: ${e.message}`)
    return []
  }
}

async function main() {
  console.log('=== Toobit Copy Trading 排行榜抓取 ===')
  console.log(`开始: ${new Date().toISOString()}`)
  
  let totalUpserted = 0
  
  for (const period of PERIODS) {
    console.log(`\n--- ${period.season} 排行榜 ---`)
    const allTraders = new Map()
    
    for (let page = 1; page <= 250; page++) {
      const list = await fetchPage(period.dataType, page, 50)
      if (list.length === 0) break
      
      for (const item of list) {
        const id = String(item.leaderUserId || '')
        if (!id || allTraders.has(id)) continue
        
        let avatar = item.avatar || null
        if (avatar === '') avatar = null
        // 过滤默认头像
        if (avatar && (avatar.includes('default') || avatar.includes('placeholder'))) avatar = null
        
        const roi = parseFloat(item.leaderAvgProfitRatio || 0) * 100
        const winRate = parseFloat(item.leaderProfitOrderRatio || 0) * 100
        
        allTraders.set(id, {
          id,
          nickname: item.nickname || null,
          avatar,
          roi,
          pnl: parseFloat(item.pnl || 0),
          winRate,
          tradeCount: parseInt(item.leaderOrderCount || 0),
          followers: parseInt(item.totalFollowerCount || 0),
          summary: item.summary || null,
          sharpeRatio: parseFloat(item.sharpeRatio || 0),
        })
      }
      
      console.log(`  页${page}: +${list.length}, 累计 ${allTraders.size}`)
      await sleep(500)
    }
    
    console.log(`  ${period.season} 共 ${allTraders.size} 个交易员`)
    
    // 写入DB
    let upserted = 0
    for (const [id, t] of allTraders) {
      // trader_sources (只在第一个period写)
      if (period.season === '7d') {
        await supabase.from('trader_sources').upsert({
          source: SOURCE,
          source_trader_id: id,
          handle: t.nickname,
          avatar_url: t.avatar,
          profile_url: `https://www.toobit.com/en-US/copytrading/trader/info?leaderUserId=${id}`,
          is_active: true,
          source_kind: 'cex',
          market_type: 'futures',
        }, { onConflict: 'source,source_trader_id' })
      }
      
      // leaderboard_ranks
      const { error } = await supabase.from('leaderboard_ranks').upsert({
        source: SOURCE,
        source_trader_id: id,
        season: period.season,
        roi_pct: t.roi,
        pnl_usd: t.pnl,
        win_rate: t.winRate,
        trade_count: t.tradeCount,
        score: Math.min(100, Math.max(0, t.roi * 0.3 + t.winRate * 0.3 + Math.min(t.tradeCount, 100) * 0.2 + Math.min(t.followers, 500) / 500 * 20)),
      }, { onConflict: 'source,source_trader_id,season' })
      
      if (!error) upserted++
    }
    
    totalUpserted += upserted
    console.log(`  写入: ${upserted}`)
  }
  
  console.log(`\n=== 完成 ===`)
  console.log(`总写入: ${totalUpserted}`)
  console.log(`结束: ${new Date().toISOString()}`)
}

main().catch(e => { console.error(e); process.exit(1) })
