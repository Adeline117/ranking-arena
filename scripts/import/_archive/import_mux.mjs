/**
 * MUX Protocol DEX 排行榜数据抓取
 * 使用 The Graph Subgraph 获取链上交易数据
 *
 * 用法: node scripts/import/import_mux.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'mux'
const TARGET_COUNT = 500
// The Graph decentralized network - requires API key (100k free queries/month)
// Get API key from: https://thegraph.com/studio/apikeys/
// MUX Protocol Arbitrum subgraph ID: 7hUM4US9DPz6JqLD6ySqwFmLq4XiAF7cEZLmEesQnYgR (Optimism data)
const GRAPH_API_KEY = process.env.THEGRAPH_API_KEY || ''
const SUBGRAPH_ID = '7hUM4US9DPz6JqLD6ySqwFmLq4XiAF7cEZLmEesQnYgR'
const SUBGRAPH_URL = GRAPH_API_KEY
  ? `https://gateway-arbitrum.network.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${SUBGRAPH_ID}`
  : null // No fallback - API key required

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 MUX Protocol ${period} ===`)

  if (!SUBGRAPH_URL) {
    console.log('  ⚠️ 需要设置 THEGRAPH_API_KEY 环境变量')
    console.log('  获取免费 API Key: https://thegraph.com/studio/apikeys/')
    return []
  }

  try {
    // Messari 标准 schema
    const query = `
      query GetTopTraders {
        accounts(
          first: ${TARGET_COUNT}
          orderBy: cumulativeClosedPositionCount
          orderDirection: desc
          where: { cumulativeClosedPositionCount_gt: 0 }
        ) {
          id
          cumulativeClosedPositionCount
          cumulativePositionCount
          positions(first: 100, orderBy: timestampClosed, orderDirection: desc) {
            id
            timestampClosed
            balance
            collateral
            realisedPnlUSD
          }
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
      return []
    }

    const accounts = json?.data?.accounts || []
    console.log(`  获取到 ${accounts.length} 个账户`)

    // 计算时间窗口
    const windowDays = period === '7D' ? 7 : period === '30D' ? 30 : 90
    const windowStart = Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000)

    const traders = []

    for (const account of accounts) {
      // 过滤时间窗口内的已关闭仓位
      const positions = (account.positions || []).filter(p =>
        p.timestampClosed && parseInt(p.timestampClosed) >= windowStart
      )

      if (positions.length === 0) continue

      // 计算 PnL 和 ROI
      let totalPnl = 0
      let totalCollateral = 0
      let wins = 0

      for (const pos of positions) {
        const pnl = parseFloat(pos.realisedPnlUSD || 0)
        const collateral = parseFloat(pos.collateral || 0)
        totalPnl += pnl
        totalCollateral += collateral
        if (pnl > 0) wins++
      }

      const roi = totalCollateral > 0 ? (totalPnl / totalCollateral) * 100 : 0
      const winRate = positions.length > 0 ? (wins / positions.length) * 100 : null

      traders.push({
        traderId: account.id.toLowerCase(),
        nickname: `${account.id.slice(0, 6)}...${account.id.slice(-4)}`,
        roi,
        pnl: totalPnl,
        winRate,
        maxDrawdown: null,
        followers: 0,
        tradesCount: positions.length,
      })
    }

    return traders.filter(t => t.traderId && t.roi !== 0)
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
      profile_url: `https://mux.network/trade?account=${t.traderId}`,
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
      arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore,
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

  console.log('MUX Protocol (Multi-chain DEX) 数据抓取开始...')
  
  if (!GRAPH_API_KEY) {
    console.error('\n❌ 需要设置 THEGRAPH_API_KEY 环境变量')
    console.error('   1. 访问 https://thegraph.com/studio/apikeys/ 注册并获取免费 API Key')
    console.error('   2. 将 THEGRAPH_API_KEY=your_key 添加到 .env 文件')
    console.error('   3. 免费额度: 100,000 queries/month')
    process.exit(1)
  }
  for (const period of targetPeriods) {
    const traders = await fetchLeaderboardData(period)
    if (traders.length > 0) await saveTraders(traders, period)
    await new Promise(r => setTimeout(r, 2000))
  }
  console.log('\n✅ MUX Protocol 完成')
}

main()
