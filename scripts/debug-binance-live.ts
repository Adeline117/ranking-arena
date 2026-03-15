/**
 * Debug script to test Binance API directly and see raw responses
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

async function testBinanceAPI() {
  console.log('='.repeat(70))
  console.log('BINANCE API DEBUG TEST')
  console.log('='.repeat(70))
  
  const apiUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
  
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
  
  console.log('\n[STEP 1] Direct API call to Binance...')
  console.log('URL:', apiUrl)
  console.log('Body:', JSON.stringify(requestBody, null, 2))
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.binance.com',
        'Referer': 'https://www.binance.com/en/copy-trading',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify(requestBody),
    })
    
    console.log('\n[RESPONSE]')
    console.log('Status:', response.status, response.statusText)
    console.log('Headers:', Object.fromEntries(response.headers.entries()))
    
    const text = await response.text()
    console.log('\n[RAW RESPONSE]')
    console.log(text.substring(0, 1000))
    
    try {
      const json = JSON.parse(text)
      console.log('\n[PARSED JSON]')
      console.log(JSON.stringify(json, null, 2).substring(0, 2000))
      
      if (json.data?.list) {
        console.log(`\n✅ Found ${json.data.list.length} traders`)
        if (json.data.list.length > 0) {
          console.log('\n[SAMPLE TRADER]')
          console.log(JSON.stringify(json.data.list[0], null, 2))
        }
      } else {
        console.log('\n❌ No traders in response')
        console.log('Response structure:', Object.keys(json))
      }
    } catch (parseErr) {
      console.log('\n❌ Failed to parse JSON:', parseErr)
    }
  } catch (err: any) {
    console.error('\n❌ Request failed:', err.message)
    console.error('Stack:', err.stack)
  }
  
  console.log('\n' + '='.repeat(70))
}

testBinanceAPI().catch(console.error)
