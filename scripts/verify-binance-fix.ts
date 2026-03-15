/**
 * Verification script for Binance connectors
 * Tests both binance_futures and binance_spot with .env.local
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'

async function verify() {
  console.log('='.repeat(60))
  console.log('BINANCE CONNECTOR VERIFICATION')
  console.log('='.repeat(60))
  
  console.log('\n[ENV] Environment variables:')
  console.log('  VPS_PROXY_SG:', process.env.VPS_PROXY_SG || '❌ NOT SET')
  console.log('  VPS_PROXY_KEY:', process.env.VPS_PROXY_KEY ? '✅ SET' : '❌ NOT SET')
  
  console.log('\n[INIT] Initializing connectors...')
  await initializeConnectors()
  
  // Test Binance Futures
  console.log('\n[TEST 1/2] binance_futures')
  console.log('-'.repeat(60))
  const futuresConnector = connectorRegistry.get('binance', 'futures')
  if (!futuresConnector) {
    console.log('❌ FAILED: Connector not found')
  } else {
    try {
      const result = await futuresConnector.discoverLeaderboard('7d', 10, 0)
      if (result.traders.length > 0) {
        console.log(`✅ SUCCESS: Got ${result.traders.length} traders`)
        console.log(`   Sample trader: ${result.traders[0].display_name}`)
        console.log(`   ROI available: ${result.traders[0].raw?.roi != null}`)
      } else {
        console.log('❌ FAILED: 0 traders returned')
      }
    } catch (err: any) {
      console.log('❌ FAILED:', err.message)
    }
  }
  
  // Test Binance Spot
  console.log('\n[TEST 2/2] binance_spot')
  console.log('-'.repeat(60))
  const spotConnector = connectorRegistry.get('binance_spot', 'spot')
  if (!spotConnector) {
    console.log('❌ FAILED: Connector not found')
  } else {
    try {
      const result = await spotConnector.discoverLeaderboard('7d', 10, 0)
      if (result.traders.length > 0) {
        console.log(`✅ SUCCESS: Got ${result.traders.length} traders`)
        console.log(`   Sample trader: ${result.traders[0].display_name}`)
        console.log(`   ROI available: ${result.traders[0].raw?.roi != null}`)
      } else {
        console.log('❌ FAILED: 0 traders returned')
      }
    } catch (err: any) {
      console.log('❌ FAILED:', err.message)
    }
  }
  
  console.log('\n' + '='.repeat(60))
  console.log('VERIFICATION COMPLETE')
  console.log('='.repeat(60))
}

verify().catch(console.error)
