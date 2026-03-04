#!/usr/bin/env node
import { chromium } from 'playwright'

const discoveredAPIs = []

async function discoverBinanceAPI() {
  console.log('🔍 Launching browser...')
  const browser = await chromium.launch({ 
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  })
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })

  const page = await context.newPage()
  
  // 拦截所有 API 请求
  page.on('request', request => {
    const url = request.url()
    if (url.includes('binance.com') && (url.includes('bapi') || url.includes('api'))) {
      const method = request.method()
      const postData = request.postData()
      console.log(`\n📡 [${method}] ${url}`)
      if (postData) {
        console.log(`   Body: ${postData.substring(0, 200)}`)
      }
    }
  })
  
  page.on('response', async response => {
    const url = response.url()
    if (url.includes('binance.com') && (url.includes('bapi') || url.includes('api'))) {
      const status = response.status()
      console.log(`   ← Status: ${status}`)
      
      try {
        const json = await response.json()
        if (json.code === '000000' && json.data) {
          console.log(`   ✅ Success! Contains data`)
          
          // 检查是否包含交易数据
          const dataStr = JSON.stringify(json.data).toLowerCase()
          if (dataStr.includes('trade') || dataStr.includes('roi') || dataStr.includes('portfolio')) {
            console.log(`   🎯 Contains trading data!`)
            discoveredAPIs.push({
              url,
              method: response.request().method(),
              postData: response.request().postData(),
              hasTradeData: true
            })
          }
        }
      } catch (e) {
        // Not JSON
      }
    }
  })

  console.log('🌐 Navigating to Binance Spot Copy Trading...')
  await page.goto('https://www.binance.com/en/copy-trading/spot-leaderboard', { 
    waitUntil: 'networkidle',
    timeout: 60000 
  })

  console.log('⏳ Waiting for leaderboard to load...')
  await page.waitForTimeout(5000)

  // 尝试滚动加载更多数据
  console.log('📜 Scrolling to trigger more API calls...')
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1000)
    await page.waitForTimeout(2000)
  }

  // 尝试切换时间范围
  console.log('🔄 Trying to click different time ranges...')
  try {
    await page.click('text=Weekly', { timeout: 3000 })
    await page.waitForTimeout(2000)
  } catch (e) {
    console.log('   Could not click Weekly')
  }

  await page.waitForTimeout(3000)

  console.log('\n\n📊 === DISCOVERED APIS ===')
  discoveredAPIs.forEach((api, idx) => {
    console.log(`\n${idx + 1}. ${api.method} ${api.url}`)
    if (api.postData) {
      console.log(`   Body: ${api.postData}`)
    }
  })

  console.log('\n\n Press Ctrl+C to exit or wait 60 seconds...')
  await page.waitForTimeout(60000)

  await browser.close()
}

discoverBinanceAPI().catch(console.error)
