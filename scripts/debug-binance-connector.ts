import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'

async function debugConnector() {
  await initializeConnectors()
  
  const connector = connectorRegistry.get('binance', 'futures') as any
  
  // Patch the proxyViaVPS method to add logging
  const originalProxy = connector.proxyViaVPS.bind(connector)
  connector.proxyViaVPS = async function(...args: any[]) {
    console.log('[DEBUG] proxyViaVPS called with:', JSON.stringify(args[0]))
    const result = await originalProxy(...args)
    console.log('[DEBUG] proxyViaVPS returned:', result ? 'data' : 'null', result ? JSON.stringify(result).substring(0, 500) : '')
    return result
  }
  
  // Patch request method too
  const originalRequest = connector.request.bind(connector)
  connector.request = async function(...args: any[]) {
    console.log('[DEBUG] request called with:', args[0])
    try {
      const result = await originalRequest(...args)
      console.log('[DEBUG] request returned:', result ? JSON.stringify(result).substring(0, 500) : 'null')
      return result
    } catch (err: any) {
      console.log('[DEBUG] request error:', err.message)
      throw err
    }
  }
  
  console.log('[TEST] Testing discoverLeaderboard...')
  const result = await connector.discoverLeaderboard('7d', 10, 0)
  console.log(`[RESULT] Got ${result.traders.length} traders`)
  console.log('[RESULT]', JSON.stringify(result, null, 2))
}

debugConnector().catch(console.error)
