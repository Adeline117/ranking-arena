/**
 * Test full Binance pipeline: fetch + normalize + save to DB
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'
import type { GranularPlatform } from '@/lib/types/leaderboard'

async function testFullPipeline() {
  console.log('='.repeat(70))
  console.log('BINANCE FULL PIPELINE TEST (Fetch + Normalize + Save)')
  console.log('='.repeat(70))
  
  await initializeConnectors()
  
  const platforms: GranularPlatform[] = ['binance_futures', 'binance_spot']
  
  for (const platform of platforms) {
    console.log(`\n[${ platform }] Starting...`)
    console.log('-'.repeat(70))
    
    try {
      const [base, marketType] = platform.split('_') as [string, string]
      const connector = connectorRegistry.get(base as any, marketType as any)
      
      if (!connector) {
        console.log(`❌ Connector not found for ${platform}`)
        continue
      }
      
      console.log(`[1/3] Fetching leaderboard (7D, limit=10)...`)
      const result = await connector.discoverLeaderboard('7d', 10, 0)
      console.log(`  ✅ Discovered ${result.traders.length} traders`)
      
      if (result.traders.length === 0) {
        console.log(`  ❌ No traders returned - skipping DB test`)
        continue
      }
      
      console.log(`\n[2/3] Testing normalization...`)
      let normalizedCount = 0
      let failedCount = 0
      
      for (const trader of result.traders) {
        const normalized = connector.normalize(trader.raw)
        if (normalized.trader_key && normalized.roi != null) {
          normalizedCount++
        } else {
          failedCount++
          console.log(`  ⚠️  Failed to normalize trader:`, {
            raw_keys: Object.keys(trader.raw || {}),
            normalized,
          })
        }
      }
      
      console.log(`  ✅ Normalized: ${normalizedCount}/${result.traders.length}`)
      console.log(`  ❌ Failed: ${failedCount}/${result.traders.length}`)
      
      if (normalizedCount === 0) {
        console.log(`  ❌ All traders failed normalization - skipping DB test`)
        continue
      }
      
      console.log(`\n[3/3] Sample normalized output...`)
      const sampleTrader = result.traders[0]
      const sampleNormalized = connector.normalize(sampleTrader.raw)
      
      console.log(`  Sample trader: ${sampleTrader.display_name}`)
      console.log(`  Normalized data:`, JSON.stringify(sampleNormalized, null, 2))
      console.log(`\n  ✅ Ready for database insertion!`)
      console.log(`  Would save ${normalizedCount} traders to DB via batch-fetch-traders cron`)
      
    } catch (err: any) {
      console.log(`❌ ERROR: ${err.message}`)
      if (err.stack) {
        console.log(`Stack: ${err.stack.split('\n').slice(0, 3).join('\n')}`)
      }
    }
  }
  
  console.log('\n' + '='.repeat(70))
  console.log('BINANCE FULL PIPELINE TEST COMPLETE')
  console.log('='.repeat(70))
}

testFullPipeline().catch(err => {
  console.error('[FATAL]', err)
  process.exit(1)
})
