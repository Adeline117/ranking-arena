/**
 * Gains Network (gTrade) DEX 排行榜数据抓取
 * 
 * 数据源策略：
 * 1. /leaderboard - 获取前25名交易员的完整统计数据 (PnL, wins, losses)
 * 2. /open-trades - 获取所有活跃交易员地址和仓位信息
 * 3. 合并计算: ROI, 胜率, PnL
 *
 * 用法: node scripts/import/import_gains.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'gains'
const TARGET_COUNT = 500
const API_BASE = 'https://backend-arbitrum.gains.trade'

/**
 * 从 /leaderboard 获取TOP交易员完整数据
 * Returns: [{address, count, count_win, count_loss, avg_win, avg_loss, total_pnl, total_pnl_usd}]
 */
async function fetchLeaderboard() {
  console.log('  📊 获取 /leaderboard 数据...')
  try {
    const response = await fetch(`${API_BASE}/leaderboard`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    })
    if (!response.ok) {
      console.log(`  ⚠ /leaderboard 响应: ${response.status}`)
      return []
    }
    const data = await response.json()
    console.log(`  ✓ 排行榜获取到 ${data.length} 个交易员`)
    return data
  } catch (e) {
    console.log(`  ✗ 排行榜获取失败: ${e.message}`)
    return []
  }
}

/**
 * 从 /open-trades 获取所有活跃交易员和仓位信息
 */
async function fetchOpenTrades() {
  console.log('  📊 获取 /open-trades 数据...')
  try {
    const response = await fetch(`${API_BASE}/open-trades`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    })
    if (!response.ok) {
      console.log(`  ⚠ /open-trades 响应: ${response.status}`)
      return []
    }
    const trades = await response.json()
    console.log(`  ✓ 获取到 ${trades.length} 个活跃交易`)

    // 按交易员分组
    const traderMap = new Map()
    for (const t of trades) {
      const addr = (t.trade?.user || '').toLowerCase()
      if (!addr) continue

      if (!traderMap.has(addr)) {
        traderMap.set(addr, {
          address: addr,
          openPositions: 0,
          totalCollateral: 0,
          totalLeverage: 0,
        })
      }
      const trader = traderMap.get(addr)
      trader.openPositions++

      // Parse collateral value
      const collateral = parseInt(t.trade?.collateralAmount || '0')
      const collateralIndex = parseInt(t.trade?.collateralIndex || '0')
      // collateralIndex 0=DAI(18dec), 1=ETH(18dec), 2=USDC(6dec), 3=USDT(6dec)
      const decimals = [18, 18, 6, 6][collateralIndex] || 6
      trader.totalCollateral += collateral / Math.pow(10, decimals)

      trader.totalLeverage += parseInt(t.trade?.leverage || '0') / 1000 // leverage is in 1000x
    }

    console.log(`  ✓ 活跃交易员: ${traderMap.size} 个`)
    return Array.from(traderMap.values())
  } catch (e) {
    console.log(`  ✗ 活跃交易获取失败: ${e.message}`)
    return []
  }
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Gains Network ${period} ===`)

  // 获取两个数据源
  const [leaderboardData, openTraders] = await Promise.all([
    fetchLeaderboard(),
    fetchOpenTrades(),
  ])

  const tradersMap = new Map()

  // 1. 先添加排行榜数据（有完整统计）
  for (const t of leaderboardData) {
    const addr = t.address.toLowerCase()
    const totalTrades = parseInt(t.count || 0)
    const wins = parseInt(t.count_win || 0)
    const losses = parseInt(t.count_loss || 0)
    const totalPnl = parseFloat(t.total_pnl_usd || t.total_pnl || 0)
    const avgWin = parseFloat(t.avg_win || 0)
    const avgLoss = Math.abs(parseFloat(t.avg_loss || 0))

    // 估算总投入 = (wins * avgWin_collateral + losses * avgLoss_collateral)
    // 简化: 用 avg_win 和 avg_loss 的绝对值估算平均仓位大小
    const avgPositionSize = (avgWin + avgLoss) / 2
    const estimatedCapital = avgPositionSize > 0 ? avgPositionSize * totalTrades : totalPnl

    const roi = estimatedCapital > 0 ? (totalPnl / estimatedCapital) * 100 : 0
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null

    tradersMap.set(addr, {
      traderId: addr,
      nickname: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
      roi,
      pnl: totalPnl,
      winRate,
      maxDrawdown: null, // 不可用
      followers: 0,
      tradesCount: totalTrades,
      hasFullData: true,
    })
  }

  // 2. 添加活跃交易员（补充数据）
  for (const t of openTraders) {
    if (tradersMap.has(t.address)) {
      // 更新现有数据的仓位信息
      const existing = tradersMap.get(t.address)
      existing.openPositions = t.openPositions
      existing.totalCollateral = t.totalCollateral
    } else {
      // 新增活跃交易员（基础数据）
      tradersMap.set(t.address, {
        traderId: t.address,
        nickname: `${t.address.slice(0, 6)}...${t.address.slice(-4)}`,
        roi: null,
        pnl: null,
        winRate: null,
        maxDrawdown: null,
        followers: 0,
        tradesCount: t.openPositions,
        hasFullData: false,
        openPositions: t.openPositions,
        totalCollateral: t.totalCollateral,
      })
    }
  }

  // 过滤：优先有完整数据的，然后是有仓位的
  const traders = Array.from(tradersMap.values())
    .filter(t => t.hasFullData || (t.tradesCount > 0))

  console.log(`  处理完成: ${traders.length} 个交易员 (${traders.filter(t => t.hasFullData).length} 有完整数据)`)
  return traders
}

async function saveTraders(traders, period) {
  if (traders.length === 0) return 0

  // 先排序：有 ROI 的在前，然后按 ROI 或仓位排序
  traders.sort((a, b) => {
    if (a.hasFullData && !b.hasFullData) return -1
    if (!a.hasFullData && b.hasFullData) return 1
    return (b.roi || 0) - (a.roi || 0) || (b.tradesCount || 0) - (a.tradesCount || 0)
  })

  const topTraders = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()

  const sourcesData = topTraders.map(t => ({
    source: SOURCE,
    source_type: 'defi',
    source_trader_id: t.traderId,
    handle: t.nickname,
    profile_url: `https://gains.trade/trader/${t.traderId}`,
    is_active: true
  }))

  await supabase.from('trader_sources').upsert(sourcesData, {
    onConflict: 'source,source_trader_id'
  })

  const snapshotsData = topTraders.map((t, idx) => ({
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
    arena_score: calculateArenaScore(t.roi || 0, t.pnl || 0, t.maxDrawdown, t.winRate, period).totalScore,
    captured_at: capturedAt
  }))

  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, { onConflict: 'source,source_trader_id,season_id' })

  if (error) {
    console.log(`  ⚠ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!e) saved++
    }
    console.log(`  逐条保存: ${saved}/${snapshotsData.length}`)
    return saved
  }

  const withRoi = topTraders.filter(t => t.roi !== null).length
  const withWr = topTraders.filter(t => t.winRate !== null).length
  const withPnl = topTraders.filter(t => t.pnl !== null).length
  console.log(`  ✓ 保存成功: ${topTraders.length} 条`)
  console.log(`    ROI覆盖: ${withRoi}/${topTraders.length} (${((withRoi/topTraders.length)*100).toFixed(0)}%)`)
  console.log(`    PNL覆盖: ${withPnl}/${topTraders.length} (${((withPnl/topTraders.length)*100).toFixed(0)}%)`)
  console.log(`    胜率覆盖: ${withWr}/${topTraders.length} (${((withWr/topTraders.length)*100).toFixed(0)}%)`)
  return topTraders.length
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const targetPeriods = arg === 'ALL' ? ['7D', '30D', '90D'] :
    arg && ['7D', '30D', '90D'].includes(arg) ? [arg] : ['7D', '30D', '90D']

  console.log('Gains Network (Arbitrum DEX) 数据抓取')
  console.log('数据源: /leaderboard (完整统计) + /open-trades (活跃交易员)')
  console.log('目标周期:', targetPeriods.join(', '))

  for (const period of targetPeriods) {
    const traders = await fetchLeaderboardData(period)
    if (traders.length > 0) {
      console.log(`\n📋 ${period} TOP 5:`)
      traders.filter(t => t.hasFullData).slice(0, 5).forEach((t, i) => {
        const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
        console.log(`  ${i + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%, PnL $${t.pnl?.toFixed(0)}, WR ${wr}, Trades: ${t.tradesCount}`)
      })
      await saveTraders(traders, period)
    } else {
      console.log(`\n⚠ ${period} 未获取到数据`)
    }
    await sleep(2000)
  }
  console.log('\n✅ Gains Network 完成')
}

main()
