/**
 * Test VPS proxy directly
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

async function testVPSProxy() {
  console.log('='.repeat(70))
  console.log('VPS PROXY TEST')
  console.log('='.repeat(70))
  
  const vpsHost = process.env.VPS_PROXY_SG
  const vpsKey = process.env.VPS_PROXY_KEY
  
  console.log('\n[CONFIG]')
  console.log('VPS Host:', vpsHost)
  console.log('VPS Key:', vpsKey ? '✅ Configured' : '❌ Missing')
  
  if (!vpsHost || !vpsKey) {
    console.log('\n❌ VPS proxy not configured!')
    return
  }
  
  const targetUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
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
  
  console.log('\n[STEP 1] Testing VPS proxy health...')
  try {
    const healthCheck = await fetch(`${vpsHost}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })
    console.log('Health check status:', healthCheck.status)
    const healthText = await healthCheck.text()
    console.log('Health response:', healthText.substring(0, 200))
  } catch (err: any) {
    console.log('❌ Health check failed:', err.message)
  }
  
  console.log('\n[STEP 2] Testing Binance API via VPS proxy...')
  try {
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
    
    console.log('Proxy request body:', JSON.stringify(proxyBody, null, 2).substring(0, 500))
    
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
    
    console.log('\n[RESPONSE]')
    console.log('Status:', response.status, response.statusText)
    console.log('Headers:', Object.fromEntries(response.headers.entries()))
    
    const text = await response.text()
    console.log('\n[RAW RESPONSE]')
    console.log(text.substring(0, 2000))
    
    try {
      const json = JSON.parse(text)
      console.log('\n[PARSED JSON]')
      
      if (json.data?.list) {
        console.log(`✅ Found ${json.data.list.length} traders via VPS proxy!`)
        if (json.data.list.length > 0) {
          console.log('\n[SAMPLE TRADER]')
          console.log(JSON.stringify(json.data.list[0], null, 2))
        }
      } else if (json.code === 0) {
        console.log('❌ Geo-block error still present via proxy')
        console.log('Message:', json.msg)
      } else {
        console.log('Response keys:', Object.keys(json))
      }
    } catch (parseErr) {
      console.log('❌ Failed to parse JSON')
    }
  } catch (err: any) {
    console.error('\n❌ VPS proxy request failed:', err.message)
    console.error('Stack:', err.stack)
  }
  
  console.log('\n' + '='.repeat(70))
}

testVPSProxy().catch(console.error)
