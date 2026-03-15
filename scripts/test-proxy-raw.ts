const vpsHost = 'http://45.76.152.169:3456'
const vpsKey = 'arena-proxy-sg-2026'

async function testProxy() {
  const targetUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
  const requestBody = {
    pageNumber: 1,
    pageSize: 5,
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

  const proxyBody = {
    url: targetUrl,
    method: 'POST',
    body: JSON.stringify(requestBody),
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://www.binance.com',
      'Referer': 'https://www.binance.com/en/copy-trading',
    },
  }

  console.log('[PROXY] Sending request to VPS proxy...')
  console.log('[PROXY] Body:', JSON.stringify(proxyBody, null, 2))

  const response = await fetch(`${vpsHost}/proxy`, {
    method: 'POST',
    headers: {
      'X-Proxy-Key': vpsKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(proxyBody),
    signal: AbortSignal.timeout(30000),
  })

  console.log('[PROXY] Response status:', response.status, response.statusText)
  console.log('[PROXY] Response headers:', JSON.stringify(Object.fromEntries(response.headers), null, 2))

  if (!response.ok) {
    const text = await response.text()
    console.log('[PROXY] Error body:', text)
    return
  }

  const data = await response.json()
  console.log('[PROXY] Success! Data:', JSON.stringify(data, null, 2).substring(0, 2000))
}

testProxy().catch(console.error)
