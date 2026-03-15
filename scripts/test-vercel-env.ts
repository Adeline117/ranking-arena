// Simulate Vercel environment by loading .env.vercel.local
import { config } from 'dotenv'
config({ path: '.env.vercel.local' })

console.log('Vercel environment variables:')
console.log('VPS_PROXY_SG:', process.env.VPS_PROXY_SG)
console.log('VPS_PROXY_KEY:', process.env.VPS_PROXY_KEY?.substring(0, 10) + '...')
console.log('VPS_SCRAPER_HOST:', process.env.VPS_SCRAPER_HOST)

import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'

async function test() {
  await initializeConnectors()
  
  const connector = connectorRegistry.get('binance', 'futures')
  if (!connector) {
    console.log('❌ Connector not found')
    return
  }
  
  console.log('\n[TEST] Testing binance_futures with Vercel env...')
  const result = await connector.discoverLeaderboard('7d', 5, 0)
  console.log(`✅ Result: ${result.traders.length} traders`)
}

test().catch(console.error)
