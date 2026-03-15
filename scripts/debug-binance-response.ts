import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'

async function debugBinanceResponse() {
  console.log('[INIT] Initializing connectors...')
  await initializeConnectors()
  
  const futuresConnector = connectorRegistry.get('binance', 'futures') as any
  
  if (!futuresConnector) {
    console.log('❌ Connector not found')
    process.exit(1)
  }

  // Manually call the API to see raw response
  const BASE_URL = 'https://www.binance.com/bapi/futures'
  const requestBody = {
    pageNumber: 1,
    pageSize: 20,
    timeRange: '7D',
    dataType: 'ROI',
    favoriteOnly: false,
    hideFull: false,
    nickname: '',
    order: 'DESC',
    userAsset: 0,
    portfolioType: 'ALL',
    useAiRecommended: false,
  }

  console.log('\n[DEBUG] Testing futures API via VPS proxy...')
  try {
    const response = await futuresConnector.proxyViaVPS(
      `${BASE_URL}/v1/friendly/future/copy-trade/home-page/query-list`,
      { method: 'POST', body: requestBody, headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.binance.com',
        'Referer': 'https://www.binance.com/en/copy-trading',
      }}
    )
    console.log('Response:', JSON.stringify(response, null, 2))
  } catch (err: any) {
    console.log('❌ VPS proxy error:', err.message)
  }

  console.log('\n[DEBUG] Testing futures API directly...')
  try {
    const response = await futuresConnector.request(
      `${BASE_URL}/v1/friendly/future/copy-trade/home-page/query-list`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://www.binance.com',
          'Referer': 'https://www.binance.com/en/copy-trading',
        },
        body: JSON.stringify(requestBody)
      }
    )
    console.log('Response:', JSON.stringify(response, null, 2))
  } catch (err: any) {
    console.log('❌ Direct error:', err.message)
  }

  console.log('\n[DEBUG] Testing spot API via VPS proxy...')
  const spotRequestBody = {
    pageNumber: 1,
    pageSize: 20,
    timeRange: '7D',
    dataType: 'ROI',
    favoriteOnly: false,
    hideFull: false,
    nickname: '',
    order: 'DESC',
    portfolioType: 'ALL',
  }
  
  try {
    const response = await futuresConnector.proxyViaVPS(
      `${BASE_URL}/v1/friendly/future/spot-copy-trade/common/home-page-list`,
      { method: 'POST', body: spotRequestBody, headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.binance.com',
        'Referer': 'https://www.binance.com/en/copy-trading/spot',
      }}
    )
    console.log('Response:', JSON.stringify(response, null, 2))
  } catch (err: any) {
    console.log('❌ VPS proxy error:', err.message)
  }
}

debugBinanceResponse()
  .then(() => console.log('\n[DEBUG] Complete'))
  .catch(err => {
    console.error('[FATAL]', err)
    process.exit(1)
  })
