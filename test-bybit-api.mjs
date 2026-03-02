#!/usr/bin/env node
/**
 * Test Bybit Spot API endpoints
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Test 1: Leader List API
console.log('Testing leader list API...')
const listUrl = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?dataType=1&timeStamp=3&sortType=1&pageNo=1&pageSize=10'
const listRes = await fetch(listUrl, { headers: { 'User-Agent': UA } })
console.log('List API status:', listRes.status)
if (listRes.ok) {
  const listData = await listRes.json()
  console.log('List API response:', JSON.stringify(listData, null, 2).slice(0, 1000))
}

// Test 2: Leader Income API with a known leaderMark (if we have one from list)
console.log('\n\nTesting leader income API...')
const incomeUrl = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=MTc1MDI4NTU0NzI2MA%3D%3D'
const incomeRes = await fetch(incomeUrl, { headers: { 'User-Agent': UA } })
console.log('Income API status:', incomeRes.status)
if (incomeRes.ok) {
  const incomeData = await incomeRes.json()
  console.log('Income API response:', JSON.stringify(incomeData, null, 2).slice(0, 1000))
}
