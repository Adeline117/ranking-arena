import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'

async function testBinanceAPIs() {
  console.log('[INIT] Initializing connectors...')
  await initializeConnectors()
  
  console.log('\n[TEST] Testing Binance Futures...')
  const futuresConnector = connectorRegistry.get('binance', 'futures')
  if (!futuresConnector) {
    console.log('❌ Futures connector not found')
  } else {
    try {
      const result = await futuresConnector.discoverLeaderboard('7d', 10, 0)
      console.log(`✅ Futures returned ${result.traders.length} traders`)
      if (result.traders.length > 0) {
        console.log('Sample trader:', JSON.stringify(result.traders[0], null, 2))
      }
    } catch (err: any) {
      console.log('❌ Futures error:', err.message)
      console.log('Stack:', err.stack)
    }
  }

  console.log('\n[TEST] Testing Binance Spot...')
  const spotConnector = connectorRegistry.get('binance_spot', 'spot')
  if (!spotConnector) {
    console.log('❌ Spot connector not found')
  } else {
    try {
      const result = await spotConnector.discoverLeaderboard('7d', 10, 0)
      console.log(`✅ Spot returned ${result.traders.length} traders`)
      if (result.traders.length > 0) {
        console.log('Sample trader:', JSON.stringify(result.traders[0], null, 2))
      }
    } catch (err: any) {
      console.log('❌ Spot error:', err.message)
      console.log('Stack:', err.stack)
    }
  }
}

testBinanceAPIs()
  .then(() => console.log('\n[TEST] Complete'))
  .catch(err => {
    console.error('[FATAL]', err)
    process.exit(1)
  })
