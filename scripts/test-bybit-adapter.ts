/**
 * Test script for Bybit Adapter
 * Usage: npx tsx scripts/test-bybit-adapter.ts
 */

import { BybitAdapter } from '@/lib/adapters/bybit-adapter'
import { ExchangeRateLimiters } from '@/lib/ratelimit/exchange-limiter'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

async function main() {
  console.log('🧪 Testing Bybit Adapter\n')

  // Validate environment variables
  if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
    console.error('❌ Missing BYBIT_API_KEY or BYBIT_API_SECRET in .env.local')
    process.exit(1)
  }

  // Create adapter
  const adapter = new BybitAdapter({
    apiKey: process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
  })

  // Get rate limiter
  const limiter = ExchangeRateLimiters.get('bybit')

  console.log('✅ Adapter initialized')
  console.log(`   Rate Limit: ${adapter.getRateLimitInfo().limit} req/${adapter.getRateLimitInfo().period}s\n`)

  // Test 1: Health Check
  console.log('📊 Test 1: Health Check')
  try {
    const isHealthy = await adapter.healthCheck()
    console.log(isHealthy ? '✅ API is healthy' : '❌ API health check failed')
  } catch (error) {
    console.error('❌ Health check error:', error)
  }
  console.log()

  // Test 2: Fetch Leaderboard (Top 10)
  console.log('📊 Test 2: Fetch Leaderboard (Top 10)')
  try {
    const result = await limiter.execute(
      () =>
        adapter.fetchLeaderboard({
          platform: 'bybit',
          limit: 10,
          sortBy: 'roi',
        }),
      'test-leaderboard'
    )

    console.log(`✅ Fetched ${result.traders.length} traders`)
    console.log(`   Total: ${result.total}`)
    console.log(`   Has More: ${result.hasMore}`)
    console.log(`   Next Cursor: ${result.nextCursor || 'N/A'}`)
    console.log('\n   Top 3 Traders:')

    result.traders.slice(0, 3).forEach((trader, index) => {
      console.log(`   ${index + 1}. ${trader.nickname}`)
      console.log(`      • ROI: ${trader.roi.toFixed(2)}%`)
      console.log(`      • PnL: $${trader.pnl.toLocaleString()}`)
      console.log(`      • Followers: ${trader.followers}`)
      console.log(`      • Win Rate: ${trader.winRate.toFixed(2)}%`)
      console.log(`      • Max Drawdown: ${trader.maxDrawdown.toFixed(2)}%`)
      console.log(`      • Data Source: ${trader.dataSource}`)
    })
  } catch (error) {
    console.error('❌ Leaderboard fetch error:', error)
  }
  console.log()

  // Test 3: Fetch Trader Detail
  console.log('📊 Test 3: Fetch Trader Detail')
  try {
    // First get a trader ID from leaderboard
    const leaderboard = await adapter.fetchLeaderboard({
      platform: 'bybit',
      limit: 1,
    })

    if (leaderboard.traders.length > 0) {
      const traderId = leaderboard.traders[0].traderId

      const detail = await limiter.execute(
        () =>
          adapter.fetchTraderDetail({
            platform: 'bybit',
            traderId,
          }),
        'test-detail'
      )

      if (detail) {
        console.log(`✅ Fetched trader detail: ${detail.nickname}`)
        console.log(`   • Trader ID: ${detail.traderId}`)
        console.log(`   • ROI: ${detail.roi.toFixed(2)}%`)
        console.log(`   • PnL: $${detail.pnl.toLocaleString()}`)
        console.log(`   • AUM: $${detail.aum?.toLocaleString() || 'N/A'}`)
        console.log(`   • Followers: ${detail.followers}`)
        console.log(`   • Win Rate: ${detail.winRate.toFixed(2)}%`)
        console.log(`   • Sharpe Ratio: ${detail.sharpeRatio?.toFixed(2) || 'N/A'}`)
        console.log(`   • Daily PnL: $${detail.dailyPnl?.toLocaleString() || 'N/A'}`)
        console.log(`   • Weekly PnL: $${detail.weeklyPnl?.toLocaleString() || 'N/A'}`)
        console.log(`   • Monthly PnL: $${detail.monthlyPnl?.toLocaleString() || 'N/A'}`)
        console.log(`   • Verified: ${detail.verified ? 'Yes' : 'No'}`)
        console.log(`   • Description: ${detail.description || 'N/A'}`)
      } else {
        console.log('❌ Trader not found')
      }
    } else {
      console.log('⚠️  No traders in leaderboard to test detail fetch')
    }
  } catch (error) {
    console.error('❌ Trader detail fetch error:', error)
  }
  console.log()

  // Test 4: Rate Limiter Status
  console.log('📊 Test 4: Rate Limiter Status')
  try {
    const status = await limiter.getStatus('test-leaderboard')
    console.log('✅ Rate limiter status:')
    console.log(`   • Remaining: ${status.remaining}`)
    console.log(`   • Limit: ${status.limit}`)
    console.log(`   • Reset: ${status.reset.toISOString()}`)
  } catch (error) {
    console.error('❌ Rate limiter status error:', error)
  }
  console.log()

  // Test 5: Filter Test (Min Followers)
  console.log('📊 Test 5: Fetch with Filters (Min 100 Followers)')
  try {
    const result = await limiter.execute(
      () =>
        adapter.fetchLeaderboard({
          platform: 'bybit',
          limit: 50,
          minFollowers: 100,
          sortBy: 'followers',
        }),
      'test-filters'
    )

    console.log(`✅ Fetched ${result.traders.length} traders with 100+ followers`)
    console.log('\n   Top 3 by Followers:')

    result.traders.slice(0, 3).forEach((trader, index) => {
      console.log(`   ${index + 1}. ${trader.nickname}`)
      console.log(`      • Followers: ${trader.followers}`)
      console.log(`      • ROI: ${trader.roi.toFixed(2)}%`)
    })
  } catch (error) {
    console.error('❌ Filter test error:', error)
  }
  console.log()

  console.log('✅ All tests completed!')
}

main().catch((error) => {
  console.error('❌ Test script failed:', error)
  process.exit(1)
})
