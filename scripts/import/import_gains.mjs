/**
 * Gains Network (gTrade) DEX 排行榜数据抓取
 * 使用 The Graph 的 gTrade Stats 子图获取交易数据
 *
 * 用法: node scripts/import/import_gains.mjs [7D|30D|90D|ALL]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing env'); process.exit(1) }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'gains'
const TARGET_COUNT = 200

// The Graph decentralized network - requires API key (100k free queries/month)
// Get API key from: https://thegraph.com/studio/apikeys/
// gTrade Stats Arbitrum v5 subgraph ID: 2DojWYiz95VaenV4aaYnGGHywZuNgHAjsYjVZGPk3gHV
const GRAPH_API_KEY = process.env.THEGRAPH_API_KEY || ''
const SUBGRAPH_ID = '2DojWYiz95VaenV4aaYnGGHywZuNgHAjsYjVZGPk3gHV'
const SUBGRAPH_URL = GRAPH_API_KEY
  ? `https://gateway-arbitrum.network.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${SUBGRAPH_ID}`
  : null

// Fallback to REST API for active traders only
const API_BASE = 'https://backend-arbitrum.gains.trade'

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

async function fetchFromSubgraph(period) {
  if (!SUBGRAPH_URL) return null

  try {
    // gTrade Stats subgraph 查询
    const query = `
      query GetTopTraders {
        traders(
          first: ${TARGET_COUNT}
          orderBy: totalPnl
          orderDirection: desc
          where: { totalTrades_gt: 0 }
        ) {
          id
          address
          totalPnl
          totalVolume
          totalTrades
          winCount
          lossCount
        }
      }
    `

    const response = await fetch(SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    })

    const json = await response.json()

    if (json.errors) {
      console.log('  GraphQL 错误:', json.errors[0]?.message)
      return null
    }

    const subgraphTraders = json?.data?.traders || []
    console.log(`  Subgraph 获取到 ${subgraphTraders.length} 个交易员`)

    return subgraphTraders.map(t => {
      const totalPnl = parseFloat(t.totalPnl || 0)
      const totalVolume = parseFloat(t.totalVolume || 0)
      const roi = totalVolume > 0 ? (totalPnl / totalVolume) * 100 : 0
      const totalTrades = parseInt(t.totalTrades || 0)
      const winCount = parseInt(t.winCount || 0)
      const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : null

      return {
        traderId: (t.address || t.id).toLowerCase(),
        nickname: `${(t.address || t.id).slice(0, 6)}...${(t.address || t.id).slice(-4)}`,
        roi,
        pnl: totalPnl,
        winRate,
        maxDrawdown: null,
        followers: 0,
        tradesCount: totalTrades,
      }
    })
  } catch (e) {
    console.log('  Subgraph 错误:', e.message)
    return null
  }
}

async function fetchFromRestApi() {
  try {
    // Fallback: 从 REST API 获取活跃交易员
    const openTradesRes = await fetch(`${API_BASE}/open-trades`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    })
    const openTrades = await openTradesRes.json() || []

    // 提取唯一交易员地址
    const positionCounts = {}
    openTrades.forEach(t => {
      const addr = t.trade?.user || t.trader
      if (addr) {
        const key = addr.toLowerCase()
        positionCounts[key] = (positionCounts[key] || 0) + 1
      }
    })

    console.log(`  REST API 发现 ${Object.keys(positionCounts).length} 个活跃交易员`)

    // 按持仓数量排序
    const sortedTraders = Object.entries(positionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TARGET_COUNT)

    return sortedTraders.map(([address, posCount]) => ({
      traderId: address,
      nickname: `${address.slice(0, 6)}...${address.slice(-4)}`,
      roi: null,
      pnl: null,
      winRate: null,
      maxDrawdown: null,
      followers: 0,
      tradesCount: posCount,
    }))
  } catch (e) {
    console.log('  REST API 错误:', e.message)
    return []
  }
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Gains Network ${period} ===`)

  // 优先使用 Subgraph（有完整数据）
  let traders = await fetchFromSubgraph(period)

  if (!traders || traders.length === 0) {
    if (!GRAPH_API_KEY) {
      console.log('  ⚠️ 建议设置 THEGRAPH_API_KEY 获取完整数据')
      console.log('  获取免费 API Key: https://thegraph.com/studio/apikeys/')
    }
    console.log('  使用 REST API fallback（仅活跃交易员）...')
    traders = await fetchFromRestApi()
  }

  console.log(`  处理完成 ${traders.length} 个交易员`)
  return traders.filter(t => t.traderId)
}

async function saveTraders(traders, period) {
  if (traders.length === 0) return 0
  // 按 ROI 或交易数量排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0) || (b.tradesCount || 0) - (a.tradesCount || 0))
  const topTraders = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()

  await supabase.from('trader_sources').upsert(
    topTraders.map(t => ({
      source: SOURCE,
      source_type: 'leaderboard',
      source_trader_id: t.traderId,
      handle: t.nickname,
      profile_url: `https://gains.trade/trader/${t.traderId}`,
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
      trades_count: t.tradesCount,
      arena_score: calculateArenaScore(t.roi || 0, t.pnl || 0, t.maxDrawdown, t.winRate, period),
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

  console.log('Gains Network (Arbitrum DEX) 数据抓取开始...')
  for (const period of targetPeriods) {
    const traders = await fetchLeaderboardData(period)
    if (traders.length > 0) await saveTraders(traders, period)
    await new Promise(r => setTimeout(r, 2000))
  }
  console.log('\n✅ Gains Network 完成')
}

main()
