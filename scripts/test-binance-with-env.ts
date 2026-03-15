import { config } from 'dotenv'
config({ path: '.env.local' })

import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'

async function test() {
  console.log('ENV loaded:', {
    VPS_PROXY_SG: process.env.VPS_PROXY_SG,
    VPS_PROXY_KEY: process.env.VPS_PROXY_KEY,
  })
  
  await initializeConnectors()
  
  const connector = connectorRegistry.get('binance', 'futures')
  if (!connector) {
    console.log('Connector not found')
    return
  }
  
  console.log('[TEST] Testing binance_futures...')
  const result = await connector.discoverLeaderboard('7d', 10, 0)
  console.log(`Result: ${result.traders.length} traders`)
  
  if (result.traders.length > 0) {
    console.log('Sample:', JSON.stringify(result.traders[0], null, 2))
  }
  
  const spotConnector = connectorRegistry.get('binance_spot', 'spot')
  if (spotConnector) {
    console.log('\n[TEST] Testing binance_spot...')
    const spotResult = await spotConnector.discoverLeaderboard('7d', 10, 0)
    console.log(`Result: ${spotResult.traders.length} traders`)
    
    if (spotResult.traders.length > 0) {
      console.log('Sample:', JSON.stringify(spotResult.traders[0], null, 2))
    }
  }
}

test().catch(console.error)
