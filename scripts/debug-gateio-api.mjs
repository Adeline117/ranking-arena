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
    headless: false, // Show browser to debug
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const page = await browser.newPage()
  
  // Capture API requests
  const apiRequests = []
  
  page.on('response', async (response) => {
    const url = response.url()
    
    // Filter for Gate.io API calls
    if (url.includes('gate.io') && (url.includes('/api') || url.includes('leader'))) {
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

  console.log('🔍 Loading Gate.io leaderboard...\n')
  await page.goto('https://www.gate.io/futures_leaderboard', {
    waitUntil: 'networkidle2',
    timeout: 30000,
  })

  console.log('\n⏳ Waiting 3 seconds for additional requests...\n')
  await new Promise(resolve => setTimeout(resolve, 3000))

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

  console.log('\n✅ Done! Check the browser window.')
  console.log('Press Ctrl+C to close.\n')

  // Keep browser open for inspection
  await new Promise(() => {})
}

main().catch(error => {
  console.error('❌ Error:', error)
  process.exit(1)
})
