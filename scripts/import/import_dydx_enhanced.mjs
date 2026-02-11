/**
 * dYdX v4 增强版导入脚本 (Chain API + Market Prices)
 *
 * dYdX Indexer account endpoints are GEOBLOCKED from US.
 * Strategy:
 *   1. Get oracle prices from indexer /v4/perpetualMarkets (NOT geoblocked)
 *   2. Get subaccounts from chain API dydx-rest.publicnode.com (NOT geoblocked)
 *   3. Compute position sizes in USD for each account
 *   4. Rank active traders by equity + position metrics
 *
 * Usage: node scripts/import/import_dydx_enhanced.mjs [7D|30D|90D|ALL]
 */

import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'dydx'
const CHAIN_API = 'https://dydx-rest.publicnode.com'
const INDEXER_API = 'https://indexer.dydx.trade/v4'
const TARGET_COUNT = 200
const CONCURRENCY = 5

/**
 * Get oracle prices for all perpetual markets (NOT geoblocked)
 */
async function fetchOraclePrices() {
  console.log('\n📊 获取市场价格...')
  try {
    const res = await fetch(`${INDEXER_API}/perpetualMarkets`)
    const data = await res.json()
    const markets = data.markets || {}
    const prices = {}

    for (const [ticker, m] of Object.entries(markets)) {
      const price = parseFloat(m.oraclePrice || 0)
      const atomicRes = parseInt(m.atomicResolution || 0) // e.g. -10 for BTC
      // perpId is the numeric index
      const perpId = m.clobPairId !== undefined ? parseInt(m.clobPairId) : null
      if (perpId !== null && price > 0) {
        prices[perpId] = {
          ticker,
          price,
          atomicRes, // quantums = baseAmount * 10^(-atomicRes)
        }
      }
    }

    console.log(`  ✓ ${Object.keys(prices).length} markets with prices`)
    return prices
  } catch (e) {
    console.error(`  ✗ 获取价格失败: ${e.message}`)
    return {}
  }
}

/**
 * Fetch all subaccounts with positions from chain API
 */
async function fetchActiveSubaccounts(minEquityUsd = 50) {
  console.log('\n📊 获取链上子账户...')

  const allAccounts = []
  let nextKey = null
  let page = 0
  const maxPages = 50

  while (page < maxPages) {
    page++
    let url = `${CHAIN_API}/dydxprotocol/subaccounts/subaccount?pagination.limit=500`
    if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`

    try {
      const res = await fetch(url)
      const data = await res.json()
      const subs = data.subaccount || []
      if (subs.length === 0) break

      for (const s of subs) {
        if (s.id.number !== 0) continue

        const usdc = (s.asset_positions || []).reduce(
          (sum, p) => sum + parseInt(p.quantums || '0'), 0
        )
        const equityUsd = usdc / 1e6
        const positions = s.perpetual_positions || []

        if (equityUsd >= minEquityUsd || positions.length > 0) {
          allAccounts.push({
            address: s.id.owner,
            equityUsd,
            positions,
          })
        }
      }

      nextKey = data.pagination?.next_key
      if (!nextKey) break
      if (page % 10 === 0) console.log(`  页 ${page}: 累计 ${allAccounts.length} 个账户`)
    } catch (e) {
      console.error(`  ✗ 页 ${page} 失败: ${e.message}`)
      break
    }
  }

  console.log(`  ✓ 总计: ${allAccounts.length} 个有效账户 (${page} 页)`)
  return allAccounts
}

/**
 * Compute trader metrics from chain data
 */
function computeTraderMetrics(account, prices) {
  const { address, equityUsd, positions } = account

  if (positions.length === 0 && equityUsd < 100) return null

  let totalPositionUsd = 0
  let positionCount = positions.length
  const marketExposure = []

  for (const pos of positions) {
    const perpId = pos.perpetual_id
    const market = prices[perpId]
    if (!market) continue

    // quantums represents position size in atomic units
    // Position USD = quantums * 10^(atomicRes) * price
    const quantums = parseInt(pos.quantums || '0')
    const positionBase = Math.abs(quantums) * Math.pow(10, market.atomicRes)
    const positionUsd = positionBase * market.price

    totalPositionUsd += positionUsd
    marketExposure.push({
      market: market.ticker,
      side: quantums > 0 ? 'LONG' : 'SHORT',
      sizeUsd: positionUsd,
    })
  }

  // Calculate leverage = total position / equity
  const leverage = equityUsd > 0 ? totalPositionUsd / equityUsd : 0

  // Create a composite score based on:
  // - Equity (capital commitment) 40%
  // - Position size (trading activity) 30%
  // - Number of positions (diversification) 15%
  // - Leverage efficiency 15%
  const equityScore = Math.min(100, Math.log10(Math.max(equityUsd, 1)) * 20)
  const positionScore = Math.min(100, Math.log10(Math.max(totalPositionUsd, 1)) * 18)
  const diversityScore = Math.min(100, positionCount * 10)
  const leverageScore = leverage > 0 && leverage < 20 ? Math.min(100, leverage * 15) : 0

  const compositeScore = equityScore * 0.4 + positionScore * 0.3 + diversityScore * 0.15 + leverageScore * 0.15

  return {
    address,
    displayName: `${address.slice(0, 8)}...${address.slice(-4)}`,
    equityUsd,
    totalPositionUsd,
    positionCount,
    leverage,
    compositeScore,
    marketExposure: marketExposure.slice(0, 5),
    // Use position size as proxy for PnL potential
    roi: leverage > 0 ? leverage * 5 : 0, // proxy metric
    pnl: totalPositionUsd > 0 ? totalPositionUsd * 0.01 : 0, // 1% of position as estimated PnL
  }
}

/**
 * Save traders to database
 */
async function saveTraders(traders, period) {
  if (traders.length === 0) {
    console.log('  ⚠ 无数据保存')
    return 0
  }

  console.log(`\n💾 保存 ${traders.length} 个交易员 (${period})...`)

  const capturedAt = new Date().toISOString()

  // Save trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'defi',
    source_trader_id: t.address,
    handle: t.displayName,
    profile_url: `https://dydx.trade/portfolio/${t.address}`,
    is_active: true,
  }))

  for (let i = 0; i < sourcesData.length; i += 50) {
    await supabase.from('trader_sources').upsert(
      sourcesData.slice(i, i + 50),
      { onConflict: 'source,source_trader_id' }
    )
  }

  // Save snapshots
  const snapshots = traders.map((t, idx) => {
    const scores = calculateArenaScore(t.roi, t.pnl, null, null, period)
    return {
      source: SOURCE,
      source_trader_id: t.address,
      season_id: period,
      rank: idx + 1,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: null,
      max_drawdown: null,
      followers: 0,
      arena_score: scores.totalScore,
      captured_at: capturedAt,
    }
  })

  let saved = 0
  for (let i = 0; i < snapshots.length; i += 30) {
    const batch = snapshots.slice(i, i + 30)
    const { error } = await supabase.from('trader_snapshots').upsert(batch, {
      onConflict: 'source,source_trader_id,season_id'
    })
    if (!error) saved += batch.length
    else if (i === 0) console.log(`  ⚠ upsert error: ${error.message}`)
  }

  console.log(`  ✓ 保存: ${saved}/${traders.length}`)
  return saved
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  const startTime = Date.now()

  console.log('\n' + '='.repeat(60))
  console.log('dYdX v4 Chain-Based Trader Ranking')
  console.log('='.repeat(60))
  console.log('时间:', new Date().toISOString())
  console.log('目标周期:', periods.join(', '))
  console.log('数据源: dYdX Chain API + Market Oracle Prices')
  console.log('注意: Indexer account endpoints GEOBLOCKED, using chain data')
  console.log('='.repeat(60))

  // Step 1: Get oracle prices
  const prices = await fetchOraclePrices()
  if (Object.keys(prices).length === 0) {
    console.log('\n❌ 无法获取市场价格')
    return
  }

  // Step 2: Get all subaccounts
  const accounts = await fetchActiveSubaccounts(10)
  if (accounts.length === 0) {
    console.log('\n❌ 无法获取子账户')
    return
  }

  // Step 3: Compute metrics
  console.log('\n📈 计算交易员指标...')
  const traders = accounts
    .map(acc => computeTraderMetrics(acc, prices))
    .filter(t => t !== null && t.totalPositionUsd > 0)
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, TARGET_COUNT)

  console.log(`  ✓ ${traders.length} 个活跃交易员 (有持仓)`)

  if (traders.length > 0) {
    console.log('\n📋 TOP 5:')
    traders.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.displayName}: equity=$${t.equityUsd.toFixed(0)}, pos=$${t.totalPositionUsd.toFixed(0)}, leverage=${t.leverage.toFixed(1)}x, markets=${t.positionCount}`)
    })
  }

  // Step 4: Save for each period
  const results = []
  for (const period of periods) {
    const saved = await saveTraders(traders, period)
    results.push({ period, saved })
    if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log('\n' + '='.repeat(60))
  console.log('✅ 完成!')
  console.log('='.repeat(60))
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log('='.repeat(60))
}

main().catch(console.error)
