#!/usr/bin/env node
/**
 * Test CTA trader detail API
 */
import { chromium } from 'playwright'

async function main() {
  console.log('启动浏览器...')
  const browser = await chromium.launch({
    headless: false, // Show browser
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  })

  const page = await context.newPage()

  console.log('导航到 Gate.io copytrading...')
  await page.goto('https://www.gate.io/copytrading', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })

  await new Promise(r => setTimeout(r, 8000))

  console.log('\n测试 CTA trader API...')
  
  const result = await page.evaluate(async () => {
    // First get a CTA trader ID
    const listResp = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=5&sort_field=NINETY_PROFIT_RATE_SORT')
    const listJson = await listResp.json()
    const traders = listJson?.data?.list || []
    
    if (traders.length === 0) {
      return { error: 'No CTA traders found' }
    }
    
    console.log(`Found ${traders.length} CTA traders`)
    const first = traders[0]
    console.log('First trader:', JSON.stringify(first, null, 2))
    
    // Try different detail API patterns
    const detailEndpoints = [
      `/apiw/v2/copy/leader/detail?leader_id=${first.nick || first.nickname}`,
      `/apiw/v2/copy/cta/detail?trader_id=${first.nick || first.nickname}`,
      `/apiw/v2/copy/leader/cta_detail?nick=${first.nick || first.nickname}`,
    ]
    
    const results = []
    
    for (const url of detailEndpoints) {
      try {
        console.log(`Trying: ${url}`)
        const resp = await fetch(url)
        const json = await resp.json()
        results.push({
          url,
          status: resp.status,
          data: json,
        })
        
        // If we got valid data with WR/MDD, stop
        if (json.data && (json.data.win_rate != null || json.data.max_drawdown != null)) {
          console.log('✅ Found WR/MDD in response!')
          break
        }
      } catch (e) {
        results.push({ url, error: e.message })
      }
    }
    
    return { listSample: first, detailAttempts: results }
  })

  console.log('\nResult:', JSON.stringify(result, null, 2))

  await new Promise(() => {}) // Keep browser open
}

main().catch(console.error)
