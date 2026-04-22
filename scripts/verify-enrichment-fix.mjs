#!/usr/bin/env node
/**
 * Verify enrichment fixes work in practice.
 * Tests GMX (basePnlUsd filter fix), MEXC (Sharpe from profitList), Gains (Copin migration).
 * Run: node scripts/verify-enrichment-fix.mjs
 */

const GMX_SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const COPIN_BASE = 'https://api.copin.io'

// GMX: verify basePnlUsd=0 trades are now included
async function testGmx() {
  const addr = '0x35831dd1b909058c06d1a81d652bae40c10f70df'
  console.log(`\n=== GMX test: ${addr} ===`)

  const query = `{ tradeActions(where: { account_eq: "${addr.toLowerCase()}", orderType_in: [2, 4, 7] }, limit: 100, orderBy: timestamp_DESC) { timestamp basePnlUsd sizeDeltaUsd isLong } }`

  const res = await fetch(GMX_SUBSQUID_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const data = await res.json()
  const actions = data?.data?.tradeActions || []

  const withPnl = actions.filter((a) => a.basePnlUsd && BigInt(a.basePnlUsd) !== 0n)
  const zeroPnl = actions.filter((a) => a.basePnlUsd && BigInt(a.basePnlUsd) === 0n)
  const noPnl = actions.filter((a) => !a.basePnlUsd)

  console.log(`  Total closing actions: ${actions.length}`)
  console.log(`  Non-zero PnL (OLD filter kept): ${withPnl.length}`)
  console.log(`  Zero PnL (OLD filter DROPPED): ${zeroPnl.length}`)
  console.log(`  No basePnlUsd field: ${noPnl.length}`)
  console.log(`  NEW total (includes zero): ${withPnl.length + zeroPnl.length}`)

  // Compute trade-level Sharpe from non-zero PnL trades
  if (withPnl.length >= 5) {
    const pnls = withPnl.map((a) => Number(BigInt(a.basePnlUsd)) / 1e30)
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length
    const std = Math.sqrt(pnls.reduce((a, r) => a + (r - mean) ** 2, 0) / pnls.length)
    const sharpe = std > 0 ? Math.round((mean / std) * Math.sqrt(365) * 100) / 100 : null
    console.log(`  Computed Sharpe (trade-level): ${sharpe}`)
  } else {
    console.log(`  ❌ Not enough trades for Sharpe: ${withPnl.length} < 5`)
  }

  return { ok: actions.length > 0, zeroPnlRecovered: zeroPnl.length }
}

// Gains: verify Copin GNS API works
async function testGains() {
  console.log('\n=== Gains Copin test ===')

  // Pick a gains trader from Copin leaderboard
  const leaderboardUrl = `${COPIN_BASE}/leaderboards/page?protocol=GNS&statisticType=MONTH&limit=3&offset=0&sort_by=ranking&sort_type=asc`
  const lbRes = await fetch(leaderboardUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  })
  const lbData = await lbRes.json()

  if (!lbData?.data?.length) {
    console.log('  ❌ Copin GNS leaderboard returned empty')
    return { ok: false }
  }

  const trader = lbData.data[0]
  console.log(`  Leaderboard trader: ${trader.account?.slice(0, 10)}...`)
  console.log(
    `  Trades: ${trader.totalTrade}, Win: ${trader.totalWin}, PnL: ${trader.totalPnl?.toFixed(2)}`
  )

  // Test position filter
  const posUrl = `${COPIN_BASE}/GNS/position/filter?accounts=${trader.account}&status=CLOSE&limit=10&sort_by=closeBlockTime&sort_type=desc`
  const posRes = await fetch(posUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  })
  const posData = await posRes.json()
  const positions = posData?.data || []

  console.log(`  Positions from Copin: ${positions.length}`)
  if (positions.length > 0) {
    const p = positions[0]
    console.log(
      `  Sample: ${p.pair} ${p.isLong ? 'LONG' : 'SHORT'} PnL=${p.pnl?.toFixed(2)} ROI=${(p.roi * 100)?.toFixed(1)}%`
    )
  }

  return { ok: positions.length > 0, positionCount: positions.length }
}

// MEXC: verify profitList has data for Sharpe
async function testMexc() {
  console.log('\n=== MEXC profitList test ===')

  // Use a known MEXC trader
  const url =
    'https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/detail?uid=10259539'
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const data = await res.json()

    if (data?.code !== 0 || !data?.data) {
      console.log(`  ❌ MEXC API returned code ${data?.code}`)
      return { ok: false }
    }

    const detail = data.data
    const profitList = detail.profitList || []
    console.log(`  profitList length: ${profitList.length}`)
    console.log(`  winRate: ${detail.winRate}, maxRetrace: ${detail.maxRetrace}`)

    if (profitList.length >= 3) {
      const yields = profitList.map((p) => p.yield || 0)
      const mean = yields.reduce((a, b) => a + b, 0) / yields.length
      const std = Math.sqrt(yields.reduce((a, r) => a + (r - mean) ** 2, 0) / yields.length)
      const sharpe = std > 0 ? Math.round((mean / std) * Math.sqrt(365) * 100) / 100 : null
      console.log(`  Computed Sharpe: ${sharpe}`)
      return { ok: true, sharpe }
    } else {
      console.log(`  ⚠️ profitList too short for Sharpe: ${profitList.length}`)
      return { ok: true, sharpe: null }
    }
  } catch (err) {
    console.log(`  ❌ MEXC fetch failed (geo-blocked?): ${err.message}`)
    return { ok: false, note: 'geo-blocked' }
  }
}

async function main() {
  console.log('Enrichment fix verification')
  console.log('============================')

  const gmx = await testGmx()
  const gains = await testGains()
  const mexc = await testMexc()

  console.log('\n============================')
  console.log('Results:')
  console.log(
    `  GMX:   ${gmx.ok ? '✅' : '❌'} (${gmx.zeroPnlRecovered || 0} zero-PnL trades recovered)`
  )
  console.log(
    `  Gains: ${gains.ok ? '✅' : '❌'} (${gains.positionCount || 0} positions from Copin)`
  )
  console.log(`  MEXC:  ${mexc.ok ? '✅' : '❌'} ${mexc.note || ''}`)
}

main().catch(console.error)
