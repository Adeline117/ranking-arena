#!/usr/bin/env tsx
/**
 * Check degradation skip count for leaderboard seasons
 */

import { config } from 'dotenv'
import { resolve } from 'path'

// Load environment variables
config({ path: resolve(__dirname, '../.env.local') })

import { getSharedRedis } from '../lib/cache/redis-client'

async function main() {
  const redis = await getSharedRedis()
  if (!redis) {
    console.log('❌ Redis not available')
    process.exit(1)
  }

  const seasons = ['7D', '30D', '90D']
  
  console.log('📊 Degradation Skip Status:')
  console.log('─'.repeat(40))
  
  for (const season of seasons) {
    const key = `leaderboard:degradation-skips:${season}`
    const value = await redis.get(key)
    // Tiered cache returns { data: ..., tier: ..., cachedAt: ..., expiresAt: ... }
    const rawValue = (value as any)?.data ?? value
    let skipCount = 0
    if (rawValue === null || rawValue === undefined) {
      skipCount = 0
    } else if (typeof rawValue === 'number') {
      skipCount = rawValue
    } else if (typeof rawValue === 'string') {
      skipCount = parseInt(rawValue, 10)
      if (isNaN(skipCount)) skipCount = 0
    }
    const status = skipCount >= 2 ? '⚠️ NEXT RUN WILL FORCE-COMPUTE' : '✅ Normal'
    console.log(`${season}: ${skipCount} skip(s) - ${status}`)
  }
  
  console.log('─'.repeat(40))
  console.log('\nNote: MAX_CONSECUTIVE_SKIPS = 3')
  console.log('After 3 skips, system auto force-computes regardless of degradation')
  
  // No need to quit - Upstash REST client doesn't have quit()
}

main().catch(console.error)
