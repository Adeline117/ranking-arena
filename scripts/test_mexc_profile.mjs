#!/usr/bin/env node
// Test: navigate to trader profile page with hex ID and capture all data
import puppeteer from 'puppeteer'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const HEX_IDS = [
  '00025d434afe4c609b24c49383597c1c',
  '000f8fb5833f40c0a05e3a3296b73f9d',
]

async function main() {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  
  const apiResponses = []
  page.on('response', async response => {
    const url = response.url()
    try {
      const ct = response.headers()['content-type'] || ''
      if (ct.includes('json')) {
        const text = await response.text()
        if (text.includes('nickname') || text.includes('nickName') || text.includes('avatar')) {
          apiResponses.push({ url: url.split('?')[0].split('/').slice(-3).join('/'), body: text.substring(0, 500) })
        }
      }
    } catch {}
  })

  for (const hexId of HEX_IDS) {
    apiResponses.length = 0
    console.log(`\n=== Testing ${hexId} ===`)
    
    await page.goto(`https://www.mexc.com/futures/copyTrade/traderInfo?traderId=${hexId}`, {
      waitUntil: 'networkidle2', timeout: 30000
    }).catch(e => console.log('Nav:', e.message))
    
    await sleep(3000)
    
    // Check page title and content
    const title = await page.title()
    console.log('Page title:', title)
    
    // Look for any trader data in the page
    const pageData = await page.evaluate(() => {
      // Try React state
      const root = document.getElementById('root') || document.getElementById('__next')
      let reactState = null
      if (root) {
        const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'))
        if (fiberKey) {
          try {
            // Walk fiber tree looking for nickname
            let fiber = root[fiberKey]
            let depth = 0
            while (fiber && depth < 100) {
              if (fiber.memoizedState?.nickname || fiber.memoizedProps?.nickname) {
                reactState = { nickname: fiber.memoizedState?.nickname || fiber.memoizedProps?.nickname }
                break
              }
              fiber = fiber.child || fiber.sibling || (fiber.return?.sibling)
              depth++
            }
          } catch {}
        }
      }
      
      // Look for window state
      const windowKeys = Object.keys(window).filter(k => 
        k.includes('store') || k.includes('Store') || k.includes('state') || k.includes('__')
      )
      
      // Get visible text content
      const bodyText = document.body?.innerText?.substring(0, 500) || ''
      
      // Look for any visible nickname/name on the page
      const nameEl = document.querySelector('[class*="nick"], [class*="name"], h1, h2, h3')
      
      return {
        reactState,
        windowKeys: windowKeys.slice(0, 10),
        bodyText,
        nameEl: nameEl?.innerText
      }
    })
    
    console.log('Body text:', pageData.bodyText.substring(0, 200))
    console.log('Name element:', pageData.nameEl)
    console.log('API responses with nickname/avatar:', apiResponses.length)
    apiResponses.forEach(r => console.log(' -', r.url, ':', r.body.substring(0, 150)))
    
    // Also try the direct API from page context
    const directApi = await page.evaluate(async (hId) => {
      const urls = [
        `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/${hId}/detail`,
        `https://www.mexc.com/api/platform/futures/copyFutures/api/v2/traders/detail?traderId=${hId}`,
        `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2/detail?traderId=${hId}`,
      ]
      const results = {}
      for (const url of urls) {
        try {
          const r = await fetch(url)
          const t = await r.text()
          results[url.split('/').slice(-2).join('/')] = { status: r.status, preview: t.substring(0, 200) }
        } catch (e) {
          results[url] = { error: e.message }
        }
      }
      return results
    }, hexId)
    
    console.log('Direct API calls:', JSON.stringify(directApi, null, 2))
  }
  
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
