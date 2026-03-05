#!/usr/bin/env node
/**
 * Debug: test Bitget spot leaderboard API for 7d/30d ROI
 */
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchLeaderboard(sortType, page = 1, pageSize = 20) {
  const resp = await fetch('https://www.bitget.com/v1/copy/spot/trader/list', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      pageNo: page,
      pageSize,
      sortField: 'ROI',
      sortType,  // 0=90d, 1=7d, 2=30d
    }),
  })
  return resp.json()
}

async function fetchTraderDetail(traderId) {
  const resp = await fetch(`https://www.bitget.com/v1/copy/spot/trader/detail?traderId=${traderId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    }
  })
  return resp.json()
}

async function main() {
  console.log('=== Testing Bitget Spot Leaderboard API ===\n')

  // Test 7d leaderboard (sortType=1)
  console.log('--- 7D Leaderboard (sortType=1) ---')
  const data7d = await fetchLeaderboard(1, 1, 5)
  console.log('Response:', JSON.stringify(data7d, null, 2).slice(0, 2000))

  await sleep(1000)

  // Test 30d leaderboard (sortType=2)
  console.log('\n--- 30D Leaderboard (sortType=2) ---')
  const data30d = await fetchLeaderboard(2, 1, 5)
  console.log('Response:', JSON.stringify(data30d, null, 2).slice(0, 1000))

  // Test trader detail
  if (data7d.data?.list?.[0]) {
    const traderId = data7d.data.list[0].traderId
    console.log(`\n--- Trader Detail for ${traderId} ---`)
    const detail = await fetchTraderDetail(traderId)
    console.log('Detail:', JSON.stringify(detail, null, 2).slice(0, 1000))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
