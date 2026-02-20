#!/usr/bin/env node
/**
 * Test all possible approaches to resolve hex trader IDs
 */
import puppeteer from 'puppeteer'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const HEX_IDS = [
  '00025d434afe4c609b24c49383597c1c',
  '000f8fb5833f40c0a05e3a3296b73f9d',
  '00204fa46d6f48e98ac7155b947439be',
  'fffbd27e46c4499aae28d7e1dc3e7046', // last in list maybe
]

async function main() {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  await page.setRequestInterception(true)
  page.on('request', req => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort()
    else req.continue()
  })
  
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(5000)
  
  // Test various endpoints for hex IDs
  const results = await page.evaluate(async (ids) => {
    const out = {}
    
    for (const id of ids) {
      out[id] = {}
      
      // 1. Try old contract API - various traderId formats
      const oldApi = await fetch(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/detail?traderId=${id}`)
      out[id].contractV2 = { status: oldApi.status, text: (await oldApi.text()).substring(0, 100) }
      
      // 2. Try platform API v2 detail with traderId
      const platApi = await fetch(`https://www.mexc.com/api/platform/futures/copyFutures/api/v2/trader/detail?traderId=${id}`)
      out[id].platV2 = { status: platApi.status, text: (await platApi.text()).substring(0, 100) }
      
      // 3. Try platform API with uid as hex
      const platUid = await fetch(`https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=5&orderBy=COMPREHENSIVE&page=1&uid=${id}`)
      const uidData = await platUid.json()
      out[id].platUidSearch = { total: uidData?.data?.total, count: uidData?.data?.content?.length }
      
      // 4. Try search by hex ID as keyword
      const searchApi = await fetch(`https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/search?keyword=${id}&limit=5`)
      out[id].search1 = { status: searchApi.status, text: (await searchApi.text()).substring(0, 200) }
      
      // 5. Try contract search
      const contractSearch = await fetch(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/list?pageNum=1&pageSize=5&keyword=${id}`)
      out[id].contractSearch = { status: contractSearch.status, text: (await contractSearch.text()).substring(0, 200) }
      
      // 6. Try the v3 API
      const v3 = await fetch(`https://www.mexc.com/api/platform/futures/copyFutures/api/v3/traders/detail?traderId=${id}`)
      out[id].v3 = { status: v3.status, text: (await v3.text()).substring(0, 100) }
    }
    
    return out
  }, HEX_IDS.slice(0, 2)) // test first 2
  
  for (const [id, r] of Object.entries(results)) {
    console.log(`\n=== ${id} ===`)
    for (const [endpoint, result] of Object.entries(r)) {
      if (result.status !== 404 || result.text?.includes('nickname') || result.total > 0) {
        console.log(`  ✨ ${endpoint}:`, JSON.stringify(result))
      } else {
        console.log(`  ✗ ${endpoint}: 404`)
      }
    }
  }
  
  // Also try: navigate to search on the copy trading page
  console.log('\n=== Testing search functionality ===')
  const searchResult = await page.evaluate(async (hexId) => {
    const r = await fetch(
      `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=30&orderBy=COMPREHENSIVE&page=1&search=${encodeURIComponent(hexId)}`
    )
    const d = await r.json()
    return { total: d?.data?.total, first: d?.data?.content?.[0] }
  }, HEX_IDS[0])
  console.log('Search result:', JSON.stringify(searchResult))
  
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
