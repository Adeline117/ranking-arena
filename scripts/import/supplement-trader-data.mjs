#!/usr/bin/env node

/**
 * Supplement Trader Data Script
 * 补充交易员详细数据：equity curves, position history, stats detail, asset breakdown
 *
 * Usage:
 *   node scripts/import/supplement-trader-data.mjs [--source binance_futures] [--limit 100]
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

const PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:7890'
const USE_PROXY = process.argv.includes('--proxy')

// Use curl with proxy for requests (bypasses region blocks)
function curlFetch(url, options = {}) {
  const args = ['curl', '-s', '--max-time', '30']

  if (USE_PROXY) {
    args.push('-x', PROXY)
  }

  if (options.method === 'POST') {
    args.push('-X', 'POST')
  }

  // Only add essential headers, avoid complex User-Agent
  args.push('-H', '"Content-Type: application/json"')
  args.push('-H', '"Accept: application/json"')
  args.push('-H', '"Origin: https://www.binance.com"')

  if (options.body) {
    // Properly escape the JSON body for shell
    const escapedBody = options.body.replace(/"/g, '\\"')
    args.push('-d', `"${escapedBody}"`)
  }

  args.push(`"${url}"`)

  try {
    const result = execSync(args.join(' '), { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash' })
    if (result.startsWith('<!') || result.startsWith('<HTML') || result.includes('Access Denied')) {
      return null
    }
    return JSON.parse(result)
  } catch (e) {
    return null
  }
}

// Rate limiting
let lastRequestTime = 0
const MIN_DELAY_MS = 2500

async function rateLimit() {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed + Math.random() * 500)
  }
  lastRequestTime = Date.now()
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function parseNum(value) {
  if (value == null) return null
  const n = typeof value === 'string' ? parseFloat(value) : Number(value)
  return isNaN(n) ? null : n
}

// ============================================
// Platform-specific API calls
// ============================================

const BINANCE_API = 'https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade'

async function fetchBinanceTraderDetails(traderId) {
  await rateLimit()

  const json = curlFetch(`${BINANCE_API}/lead-portfolio/query-portfolio`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      'Accept': 'application/json',
      'Origin': 'https://www.binance.com',
      'Referer': 'https://www.binance.com/en/copy-trading',
    },
    body: JSON.stringify({ portfolioId: traderId }),
  })

  if (!json) {
    console.log(`    ⚠️ Portfolio API failed`)
    return null
  }

  if (json.code && json.code !== '000000') {
    console.log(`    ⚠️ Portfolio API error: ${json.code} - ${json.message || 'Unknown'}`)
    return null
  }

  return json?.data || null
}

async function fetchBinancePerformance(traderId, timeRange = 'QUARTERLY') {
  await rateLimit()

  const json = curlFetch(`${BINANCE_API}/lead-portfolio/query-performance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      'Accept': 'application/json',
      'Origin': 'https://www.binance.com',
      'Referer': 'https://www.binance.com/en/copy-trading',
    },
    body: JSON.stringify({ portfolioId: traderId, timeRange }),
  })

  if (!json) {
    return null
  }

  if (json.code && json.code !== '000000') {
    console.log(`    ⚠️ Performance API error: ${json.code}`)
    return null
  }

  return json?.data || null
}

async function fetchBinancePositions(traderId) {
  await rateLimit()

  const json = curlFetch(`${BINANCE_API}/lead-portfolio/query-position-history`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      'Accept': 'application/json',
      'Origin': 'https://www.binance.com',
      'Referer': 'https://www.binance.com/en/copy-trading',
    },
    body: JSON.stringify({ portfolioId: traderId, pageNumber: 1, pageSize: 100 }),
  })

  if (!json) return []
  return json?.data?.list || []
}

async function fetchBybitTraderDetails(traderId) {
  await rateLimit()

  try {
    const response = await fetch('https://www.bybit.com/x-api/fapi/beehive/public/v1/common/leader-info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        'Accept': 'application/json',
        'Origin': 'https://www.bybit.com',
        'Referer': 'https://www.bybit.com/copyTrade',
      },
      body: JSON.stringify({ leaderId: traderId }),
    })

    if (!response.ok) return null
    const json = await response.json()
    return json?.result || null
  } catch {
    return null
  }
}

async function fetchBybitPerformance(traderId) {
  await rateLimit()

  try {
    const response = await fetch('https://www.bybit.com/x-api/fapi/beehive/public/v1/common/leader-chart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        'Accept': 'application/json',
        'Origin': 'https://www.bybit.com',
        'Referer': 'https://www.bybit.com/copyTrade',
      },
      body: JSON.stringify({ leaderId: traderId, days: 90 }),
    })

    if (!response.ok) return null
    const json = await response.json()
    return json?.result || null
  } catch {
    return null
  }
}

// ============================================
// Data processing and saving
// ============================================

async function saveEquityCurve(source, traderId, equityCurve, period) {
  if (!equityCurve || equityCurve.length === 0) return 0

  const now = new Date().toISOString()

  // Delete old data for this period first, then insert new
  await supabase
    .from('trader_equity_curve')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .eq('period', period)

  const records = equityCurve.map(point => ({
    source,
    source_trader_id: traderId,
    period,
    data_date: point.date,
    roi_pct: point.roi,
    pnl_usd: point.pnl || null,
    captured_at: now,
  }))

  const { error } = await supabase
    .from('trader_equity_curve')
    .insert(records)

  if (error) {
    console.log(`    ⚠️ Equity curve save error: ${error.message}`)
    return 0
  }

  return records.length
}

async function savePositionHistory(source, traderId, positions) {
  if (!positions || positions.length === 0) return 0

  const now = new Date().toISOString()

  // Delete recent position history first (keep last 7 days for comparison)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await supabase
    .from('trader_position_history')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .gt('captured_at', sevenDaysAgo)

  const records = positions.map(pos => ({
    source,
    source_trader_id: traderId,
    symbol: pos.symbol || pos.pair || '',
    direction: pos.direction || (pos.side?.toLowerCase() === 'buy' ? 'long' : 'short'),
    position_type: pos.positionType || 'perpetual',
    margin_mode: pos.marginMode || 'cross',
    open_time: pos.openTime || pos.entryTime || null,
    close_time: pos.closeTime || pos.exitTime || null,
    entry_price: parseNum(pos.entryPrice || pos.avgEntryPrice),
    exit_price: parseNum(pos.closePrice || pos.exitPrice),
    max_position_size: parseNum(pos.maxPositionSize || pos.maxQty),
    closed_size: parseNum(pos.closedSize || pos.closedQty),
    pnl_usd: parseNum(pos.pnl || pos.realizedPnl),
    pnl_pct: parseNum(pos.pnlPct || pos.roi),
    status: pos.status || 'closed',
    captured_at: now,
  }))

  const { error } = await supabase
    .from('trader_position_history')
    .insert(records)

  if (error) {
    console.log(`    ⚠️ Position history save error: ${error.message}`)
    return 0
  }

  return records.length
}

async function saveAssetBreakdown(source, traderId, assets, period) {
  if (!assets || assets.length === 0) return 0

  const now = new Date().toISOString()

  // Delete old data for this period first
  await supabase
    .from('trader_asset_breakdown')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .eq('period', period)

  const records = assets.map(asset => ({
    source,
    source_trader_id: traderId,
    period,
    symbol: asset.symbol || asset.coin || '',
    weight_pct: parseNum(asset.weight || asset.percentage) || 0,
    captured_at: now,
  }))

  const { error } = await supabase
    .from('trader_asset_breakdown')
    .insert(records)

  if (error) {
    console.log(`    ⚠️ Asset breakdown save error: ${error.message}`)
    return 0
  }

  return records.length
}

async function saveStatsDetail(source, traderId, stats, period) {
  if (!stats) return 0

  const now = new Date().toISOString()

  // Delete today's stats for this period first
  const today = new Date().toISOString().split('T')[0]
  await supabase
    .from('trader_stats_detail')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .eq('period', period)
    .gte('captured_at', today)

  const record = {
    source,
    source_trader_id: traderId,
    period,
    sharpe_ratio: parseNum(stats.sharpeRatio || stats.sharpe),
    copiers_pnl: parseNum(stats.copiersPnl || stats.copierProfit),
    copiers_count: parseNum(stats.copiersCount || stats.copyCount),
    winning_positions: parseNum(stats.winningPositions || stats.winCount),
    total_positions: parseNum(stats.totalPositions || stats.tradeCount),
    avg_holding_time_hours: parseNum(stats.avgHoldingTimeHours || stats.avgHoldingTime),
    avg_profit: parseNum(stats.avgProfit || stats.avgWin),
    avg_loss: parseNum(stats.avgLoss),
    captured_at: now,
  }

  const { error } = await supabase
    .from('trader_stats_detail')
    .insert(record)

  if (error) {
    console.log(`    ⚠️ Stats detail save error: ${error.message}`)
    return 0
  }

  return 1
}

async function updateTraderProfile(source, traderId, profile) {
  if (!profile) return 0

  // Update trader_sources with additional data
  const { error } = await supabase
    .from('trader_sources')
    .upsert({
      source,
      source_trader_id: traderId,
      handle: profile.nickName || profile.nickname || traderId,
      avatar_url: profile.userPhotoUrl || profile.avatar || null,
      profile_url: profile.profileUrl || null,
      market_type: 'futures',
    }, { onConflict: 'source,source_trader_id' })

  if (error) {
    console.log(`    ⚠️ Profile update error: ${error.message}`)
    return 0
  }

  return 1
}

// ============================================
// Hyperliquid API
// ============================================

async function fetchHyperliquidTraderDetails(address) {
  await rateLimit()

  try {
    // Fetch leaderboard to get trader stats
    const response = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard')
    if (!response.ok) return null

    const data = await response.json()
    const trader = data.leaderboardRows?.find(r => r.ethAddress?.toLowerCase() === address.toLowerCase())

    if (!trader) return null

    return trader
  } catch (e) {
    console.log(`    ⚠️ Hyperliquid fetch error: ${e.message}`)
    return null
  }
}

// ============================================
// OKX API
// ============================================

const OKX_API = 'https://www.okx.com/api/v5/copytrading'

// Cache OKX traders to avoid repeated API calls
let okxTradersCache = null
let okxTradersCacheTime = 0
const OKX_CACHE_TTL = 60000 // 1 minute

async function fetchOkxAllTraders() {
  const now = Date.now()
  if (okxTradersCache && now - okxTradersCacheTime < OKX_CACHE_TTL) {
    return okxTradersCache
  }

  try {
    const response = await fetch(`${OKX_API}/public-lead-traders?instType=SWAP`)
    if (!response.ok) return []

    const json = await response.json()
    if (json.code !== '0') return []

    okxTradersCache = json.data?.[0]?.ranks || []
    okxTradersCacheTime = now
    return okxTradersCache
  } catch (e) {
    console.log(`    ⚠️ OKX fetch error: ${e.message}`)
    return []
  }
}

async function fetchOkxTraderDetails(traderId) {
  await rateLimit()

  const ranks = await fetchOkxAllTraders()

  // Try multiple matching strategies
  const traderIdLower = traderId.toLowerCase()
  const trader = ranks.find(t => {
    // Match by uniqueName
    if (t.uniqueName === traderId) return true
    // Match by nickName (exact)
    if (t.nickName === traderId) return true
    // Match by nickName (case-insensitive)
    if (t.nickName?.toLowerCase() === traderIdLower) return true
    // Match by base64 encoded nickName (OKX sometimes uses this)
    try {
      const decoded = Buffer.from(traderId, 'base64').toString('utf-8')
      if (t.nickName === decoded) return true
    } catch {}
    // Match uniqueName case-insensitive
    if (t.uniqueName?.toLowerCase() === traderIdLower) return true
    return false
  })

  return trader || null
}

async function fetchOkxTraderPerformance(traderId) {
  // Use the same fetch function which uses the cache
  const trader = await fetchOkxTraderDetails(traderId)
  if (!trader) return null

  // Extract pnlRatios as equity curve
  const pnlRatios = trader.pnlRatios || []
  return pnlRatios.map(p => ({
    date: new Date(parseInt(p.beginTs)).toISOString().split('T')[0],
    roi: parseFloat(p.pnlRatio || 0) * 100,
    pnl: 0,
  }))
}

// ============================================
// GMX API (Subgraph)
// ============================================

const GMX_SUBGRAPH = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'

async function fetchGmxTraderDetails(address) {
  await rateLimit()

  try {
    const query = `{
      accountStats(where: {id_containsInsensitive: "${address}"}, limit: 1) {
        id
        wins
        losses
        realizedPnl
        maxCapital
        closedCount
        volume
      }
    }`

    const response = await fetch(GMX_SUBGRAPH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })

    if (!response.ok) return null

    const data = await response.json()
    const stats = data?.data?.accountStats?.[0]

    if (!stats) return null

    return stats
  } catch (e) {
    console.log(`    ⚠️ GMX fetch error: ${e.message}`)
    return null
  }
}

async function fetchGmxPositionHistory(address) {
  await rateLimit()

  try {
    const query = `{
      positionDecreases(
        where: {account_containsInsensitive: "${address}"}
        orderBy: timestamp_DESC
        limit: 100
      ) {
        id
        account
        market
        collateralToken
        sizeInUsd
        sizeDeltaUsd
        isLong
        timestamp
        basePnlUsd
        priceImpactUsd
      }
    }`

    const response = await fetch(GMX_SUBGRAPH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })

    if (!response.ok) return []

    const data = await response.json()
    return data?.data?.positionDecreases || []
  } catch (e) {
    console.log(`    ⚠️ GMX positions fetch error: ${e.message}`)
    return []
  }
}

// ============================================
// Main processing
// ============================================

async function processTrader(source, traderId) {
  console.log(`  Processing ${traderId}...`)

  let totalSaved = 0

  if (source === 'binance_futures') {
    // Fetch profile
    const profile = await fetchBinanceTraderDetails(traderId)
    if (profile) {
      const profileSaved = await updateTraderProfile(source, traderId, profile)
      totalSaved += profileSaved

      // Extract and save stats detail
      const stats = {
        sharpeRatio: profile.sharpeRatio,
        copiersCount: profile.currentCopyCount || profile.copierCount,
        copiersPnl: profile.copiersTotalPnl,
        winningPositions: profile.winCount,
        totalPositions: profile.tradeCount,
        avgHoldingTimeHours: profile.avgHoldingTime,
        avgProfit: profile.avgProfit,
        avgLoss: profile.avgLoss,
      }
      totalSaved += await saveStatsDetail(source, traderId, stats, '90D')

      // Extract and save asset breakdown
      const assets = profile.symbolRankings || profile.topSymbols || []
      if (assets.length > 0) {
        totalSaved += await saveAssetBreakdown(source, traderId, assets, '90D')
      }
    }

    // Fetch equity curve
    for (const [timeRange, period] of [['QUARTERLY', '90D'], ['MONTHLY', '30D'], ['WEEKLY', '7D']]) {
      const perf = await fetchBinancePerformance(traderId, timeRange)
      if (perf) {
        const chartData = perf.performanceRetList || perf.chartData || []
        if (chartData.length > 0) {
          const equityCurve = chartData.map(point => ({
            date: new Date(point.time || point.date || Date.now()).toISOString().split('T')[0],
            roi: parseNum(point.value ?? point.roi) ?? 0,
            pnl: parseNum(point.pnl) ?? 0,
          }))
          totalSaved += await saveEquityCurve(source, traderId, equityCurve, period)
        }
      }
    }

    // Fetch position history
    const positions = await fetchBinancePositions(traderId)
    if (positions.length > 0) {
      totalSaved += await savePositionHistory(source, traderId, positions)
    }

  } else if (source === 'hyperliquid') {
    // Fetch trader data from leaderboard
    const trader = await fetchHyperliquidTraderDetails(traderId)
    if (trader) {
      // Update profile
      const profileSaved = await updateTraderProfile(source, traderId, {
        nickName: trader.ethAddress?.slice(0, 10) + '...',
        profileUrl: `https://app.hyperliquid.xyz/leaderboard`,
      })
      totalSaved += profileSaved

      // Extract and save equity curve from windowPerformances
      const windowPerformances = trader.windowPerformances || []
      for (const [window, perf] of windowPerformances) {
        if (!perf) continue

        const periodMap = { day: '7D', week: '7D', month: '30D', allTime: '90D' }
        const period = periodMap[window]
        if (!period) continue

        // Save stats detail
        const stats = {
          copiersPnl: null,
          copiersCount: null,
        }
        totalSaved += await saveStatsDetail(source, traderId, stats, period)
      }
    }

  } else if (source === 'gmx') {
    // Fetch trader stats from GMX subgraph
    const trader = await fetchGmxTraderDetails(traderId)
    if (trader) {
      // Update profile
      const profileSaved = await updateTraderProfile(source, traderId, {
        nickName: traderId.slice(0, 10) + '...',
        profileUrl: `https://app.gmx.io/#/leaderboard`,
      })
      totalSaved += profileSaved

      // Calculate win rate and save stats
      const wins = parseInt(trader.wins || 0)
      const losses = parseInt(trader.losses || 0)
      const closedCount = parseInt(trader.closedCount || 0)
      const realizedPnl = parseFloat(trader.realizedPnl || 0) / 1e30
      const maxCapital = parseFloat(trader.maxCapital || 0) / 1e30

      const stats = {
        winningPositions: wins,
        totalPositions: closedCount,
        copiersPnl: realizedPnl,
      }
      totalSaved += await saveStatsDetail(source, traderId, stats, '90D')
    }

    // Fetch position history
    const positions = await fetchGmxPositionHistory(traderId)
    if (positions.length > 0) {
      const formattedPositions = positions.map(pos => ({
        symbol: pos.market || 'UNKNOWN',
        direction: pos.isLong ? 'long' : 'short',
        positionType: 'perpetual',
        marginMode: 'cross',
        openTime: null,
        closeTime: new Date(parseInt(pos.timestamp) * 1000).toISOString(),
        entryPrice: null,
        exitPrice: null,
        maxPositionSize: parseFloat(pos.sizeInUsd || 0) / 1e30,
        closedSize: parseFloat(pos.sizeDeltaUsd || 0) / 1e30,
        pnl: parseFloat(pos.basePnlUsd || 0) / 1e30,
        pnlPct: null,
        status: 'closed',
      }))
      totalSaved += await savePositionHistory(source, traderId, formattedPositions)
    }

  } else if (source === 'okx_futures' || source === 'okx_web3') {
    // Fetch trader data from OKX
    const trader = await fetchOkxTraderDetails(traderId)
    if (trader) {
      // Update profile
      const profileSaved = await updateTraderProfile(source, traderId, {
        nickName: trader.nickName,
        profileUrl: `https://www.okx.com/copy-trading/account?uniqueName=${trader.uniqueName}`,
      })
      totalSaved += profileSaved

      // Save stats detail
      const winRatio = parseFloat(trader.winRatio || 0)
      const stats = {
        copiersCount: parseInt(trader.copyTraderNum || 0),
        aum: parseFloat(trader.aum || 0),
      }
      totalSaved += await saveStatsDetail(source, traderId, stats, '90D')
    }

    // Fetch and save equity curve
    const equityCurve = await fetchOkxTraderPerformance(traderId)
    if (equityCurve && equityCurve.length > 0) {
      totalSaved += await saveEquityCurve(source, traderId, equityCurve, '90D')
    }

  } else if (source === 'bybit') {
    // Fetch profile
    const profile = await fetchBybitTraderDetails(traderId)
    if (profile) {
      const profileSaved = await updateTraderProfile(source, traderId, {
        nickName: profile.nickName,
        avatar: profile.avatar,
        profileUrl: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${traderId}`,
      })
      totalSaved += profileSaved

      // Extract and save stats detail
      const stats = {
        copiersCount: profile.copierCount,
        copiersPnl: profile.copierTotalPnl,
        winningPositions: profile.winCount,
        totalPositions: profile.totalTradeCount,
      }
      totalSaved += await saveStatsDetail(source, traderId, stats, '90D')
    }

    // Fetch equity curve
    const perf = await fetchBybitPerformance(traderId)
    if (perf) {
      const chartData = perf.chart || perf.equityCurve || []
      if (chartData.length > 0) {
        const equityCurve = chartData.map(point => ({
          date: new Date(point.time || point.date || Date.now()).toISOString().split('T')[0],
          roi: parseNum(point.roi ?? point.value) ?? 0,
          pnl: parseNum(point.pnl) ?? 0,
        }))
        totalSaved += await saveEquityCurve(source, traderId, equityCurve, '90D')
      }
    }
  }

  console.log(`    ✅ Saved ${totalSaved} records`)
  return totalSaved
}

async function main() {
  console.log('📊 Supplement Trader Data')
  console.log('='.repeat(50))

  // Parse arguments
  const args = process.argv.slice(2)
  const sourceIndex = args.indexOf('--source')
  const limitIndex = args.indexOf('--limit')

  const targetSource = sourceIndex >= 0 ? args[sourceIndex + 1] : null
  const limit = limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) : 50

  console.log(`Source: ${targetSource || 'all'}`)
  console.log(`Limit: ${limit}`)
  console.log('')

  // Check geo-restrictions
  console.log('⚠️  Note: Binance/Bybit APIs may be geo-blocked. Use --proxy or run from allowed region.')
  console.log('')

  // Get traders that need supplementing
  const sources = targetSource ? [targetSource] : ['hyperliquid', 'binance_futures', 'bybit']

  let totalProcessed = 0
  let totalSaved = 0

  for (const source of sources) {
    console.log(`\n🔍 Processing ${source}...`)

    // Get top traders without detailed data
    const { data: traders, error } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, roi, arena_score')
      .eq('source', source)
      .eq('season_id', '30D')
      .not('roi', 'is', null)
      .order('arena_score', { ascending: false, nullsFirst: false })
      .limit(limit)

    if (error) {
      console.log(`  ❌ Error fetching traders: ${error.message}`)
      continue
    }

    console.log(`  Found ${traders.length} traders to process`)

    for (const trader of traders) {
      try {
        const saved = await processTrader(source, trader.source_trader_id)
        totalSaved += saved
        totalProcessed++

        // Random delay between traders
        await sleep(1000 + Math.random() * 2000)
      } catch (e) {
        console.log(`  ❌ Error processing ${trader.source_trader_id}: ${e.message}`)
      }
    }
  }

  console.log('\n' + '='.repeat(50))
  console.log('📈 Summary')
  console.log(`  Traders processed: ${totalProcessed}`)
  console.log(`  Records saved: ${totalSaved}`)
}

main().catch(console.error)
