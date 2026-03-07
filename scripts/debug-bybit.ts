/**
 * Debug script to inspect Bybit page and API calls
 */

import { createBrowser, createStealthContext, navigateStealth } from '../lib/cron/scrapers/playwright-scraper'

async function debugBybit() {
  const browser = await createBrowser({ headless: true }) // Headless mode
  
  try {
    const context = await createStealthContext(browser)
    const page = await context.newPage()
    
    // Log ALL responses
    page.on('response', async (response) => {
      const url = response.url()
      const type = response.request().resourceType()
      
      // Only log API calls
      if (type === 'xhr' || type === 'fetch') {
        console.log(`📡 [${type}] ${url}`)
        
        // If it looks like a leaderboard API
        if (
          url.includes('leader') ||
          url.includes('rank') ||
          url.includes('copy') ||
          url.includes('beehive')
        ) {
          try {
            const body = await response.json()
            console.log(`   └─ Response:`, JSON.stringify(body).slice(0, 200))
          } catch {
            console.log(`   └─ (not JSON)`)
          }
        }
      }
    })
    
    console.log('🌐 Navigating to Bybit leaderboard...')
    const url = 'https://www.bybit.com/copyTrade/trade/leader-list'
    console.log(`   URL: ${url}`)
    await navigateStealth(page, url, { timeout: 45000 })
    
    console.log('⏳ Waiting 10 seconds for API calls...')
    await page.waitForTimeout(10000)
    
    console.log('✅ Debug complete. Keeping browser open for 60s...')
    await page.waitForTimeout(60000)
    
    await context.close()
    
  } catch (err) {
    console.error('❌ Debug failed:', err)
  } finally {
    await browser.close()
  }
}

debugBybit()
