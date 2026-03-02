#!/usr/bin/env node
// Test Bitget API with real trader IDs

const API_URL = 'https://www.bitget.com/v1/trigger/trace/public/cycleData'

const testIds = [
  'b9b04b738cb33957a395', // First from DB
  'bbb44974', // One that failed
  'b0b74f758bb03a57ac92', // okuribito
]

for (const traderId of testIds) {
  console.log(`\n Testing ${traderId}...`)
  
  for (const cycleTime of [7, 30, 90]) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Origin': 'https://www.bitget.com',
          'Referer': 'https://www.bitget.com/copy-trading/futures',
        },
        body: JSON.stringify({
          languageType: 0,
          triggerUserId: traderId,
          cycleTime,
        })
      })

      const json = await response.json()
      
      if (json.code === '00000' && json.data?.statisticsDTO) {
        const data = json.data.statisticsDTO
        console.log(`  ✓ ${cycleTime}d: WR=${data.winningRate} MDD=${data.maxRetracement} TC=${data.totalOrders}`)
      } else {
        console.log(`  ✗ ${cycleTime}d: code=${json.code} msg=${json.msg || 'no data'}`)
      }
    } catch (e) {
      console.log(`  ✗ ${cycleTime}d: ${e.message}`)
    }
    
    await new Promise(r => setTimeout(r, 300))
  }
}
