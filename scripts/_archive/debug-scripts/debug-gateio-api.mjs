#!/usr/bin/env node
/**
 * Debug script to find Gate.io API endpoints
 * Captures network requests when loading leaderboard page
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

async function main() {
  console.log('🌐 Launching browser...\n')
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const page = await browser.newPage()
  
  // Capture API requests
  const apiRequests = []
  
  page.on('response', async (response) => {
    const url = response.url()
    
    // Filter for Gate API calls (both .io and .com)
    if (url.includes('gate') && (url.includes('/api') || url.includes('leader') || url.includes('ranking') || url.includes('copy'))) {
      try {
        const status = response.status()
        const contentType = response.headers()['content-type'] || ''
        
        console.log(`📡 ${status} ${url}`)
        
        if (contentType.includes('application/json')) {
          const json = await response.json()
          apiRequests.push({
            url,
            status,
            data: json,
          })
          
          // Print sample data
          console.log(`   Data keys: ${Object.keys(json).join(', ')}`)
          if (json.data && Array.isArray(json.data)) {
            console.log(`   Array length: ${json.data.length}`)
            if (json.data[0]) {
              console.log(`   First item keys: ${Object.keys(json.data[0]).join(', ')}`)
            }
          }
          console.log('')
        }
      } catch (e) {
        // Not JSON or error parsing
      }
    }
  })

  // Try different URLs to find the leaderboard
  const urls = [
    'https://www.gate.io/copy-trading',
    'https://www.gate.com/copy-trading',
    'https://www.gate.io/futures_leaderboard',
  ]
  
  for (const url of urls) {
    console.log(`🔍 Trying ${url}...\n`)
    
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      
      // Wait for network to settle
      await new Promise(resolve => setTimeout(resolve, 3000))
      
      console.log(`   Current URL: ${page.url()}\n`)
      
      if (apiRequests.length > 0) {
        console.log(`   ✅ Found ${apiRequests.length} API requests so far\n`)
      }
    } catch (e) {
      console.log(`   ⚠️  Failed: ${e.message}\n`)
    }
  }
  
  console.log('Final URL:', page.url())

  console.log('\n⏳ Waiting 5 seconds for page to fully load...\n')
  await new Promise(resolve => setTimeout(resolve, 5000))
  
  // Print current URL
  console.log(`Current URL: ${page.url()}\n`)
  
  // Take screenshot to debug
  await page.screenshot({ path: '/tmp/gateio-debug.png' })
  console.log('Screenshot saved to /tmp/gateio-debug.png\n')
  
  // Print page content sample
  const bodyHTML = await page.evaluate(() => document.body.innerHTML)
  console.log('Page content preview:')
  console.log(bodyHTML.substring(0, 500))
  console.log('...\n')

  console.log('\n═══════════════════════════════════════')
  console.log(`Captured ${apiRequests.length} API requests`)
  console.log('═══════════════════════════════════════\n')

  // Try clicking on a trader to see detail API
  try {
    console.log('🖱️  Trying to click first trader...\n')
    
    // Wait for trader list to load
    await page.waitForSelector('[class*="trader"], [class*="leader"], a[href*="leaderboard"]', {
      timeout: 10000,
    })
    
    const traderLinks = await page.$$('a[href*="leaderboard"]')
    
    if (traderLinks.length > 0) {
      console.log(`Found ${traderLinks.length} trader links\n`)
      
      // Click first trader
      await traderLinks[0].click()
      
      console.log('⏳ Waiting for detail page...\n')
      await new Promise(resolve => setTimeout(resolve, 3000))
      
      console.log('\n═══════════════════════════════════════')
      console.log(`Total API requests: ${apiRequests.length}`)
      console.log('═══════════════════════════════════════\n')
    }
  } catch (e) {
    console.log(`⚠️  Could not click trader: ${e.message}\n`)
  }

  // Print all captured URLs
  console.log('📋 All API URLs:\n')
  apiRequests.forEach((req, i) => {
    console.log(`${i + 1}. ${req.url}`)
  })

  console.log('\n✅ Done!')
  
  await browser.close()
}

main().catch(error => {
  console.error('❌ Error:', error)
  process.exit(1)
})
