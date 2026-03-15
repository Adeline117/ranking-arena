/**
 * Simple test to verify Binance connectors fetch data and normalize correctly
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'

async function test() {
  console.log('='.repeat(70))
  console.log('SIMPLE BINANCE TEST')
  console.log('='.repeat(70))
  
  await initializeConnectors()
  
  // Test Futures
  console.log('\n[1/2] binance_futures')
  const futures = connectorRegistry.get('binance', 'futures')
  if (futures) {
    const result = await futures.discoverLeaderboard('7d', 20, 0)
    console.log(`  Discovered: ${result.traders.length} traders`)
    
    if (result.traders.length > 0) {
      const sample = result.traders[0]
      const normalized = futures.normalize(sample.raw)
      console.log(`  Sample trader: ${normalized.display_name}`)
      console.log(`  Normalized ROI: ${normalized.roi}`)
      console.log(`  Normalized trader_key: ${normalized.trader_key}`)
      
      // Check if any traders failed normalization
      let failedCount = 0
      for (const trader of result.traders) {
        const norm = futures.normalize(trader.raw)
        if (!norm.trader_key || norm.roi == null) {
          failedCount++
        }
      }
      console.log(`  Failed normalization: ${failedCount}/${result.traders.length}`)
    }
  }
  
  // Test Spot
  console.log('\n[2/2] binance_spot')
  const spot = connectorRegistry.get('binance_spot', 'spot')
  if (spot) {
    const result = await spot.discoverLeaderboard('7d', 20, 0)
    console.log(`  Discovered: ${result.traders.length} traders`)
    
    if (result.traders.length > 0) {
      const sample = result.traders[0]
      const normalized = spot.normalize(sample.raw)
      console.log(`  Sample trader: ${normalized.display_name}`)
      console.log(`  Normalized ROI: ${normalized.roi}`)
      console.log(`  Normalized trader_key: ${normalized.trader_key}`)
      
      // Check if any traders failed normalization
      let failedCount = 0
      for (const trader of result.traders) {
        const norm = spot.normalize(trader.raw)
        if (!norm.trader_key || norm.roi == null) {
          failedCount++
        }
      }
      console.log(`  Failed normalization: ${failedCount}/${result.traders.length}`)
    }
  } else {
    console.log('  ❌ Connector not found')
  }
  
  console.log('\n' + '='.repeat(70))
}

test().catch(console.error)
