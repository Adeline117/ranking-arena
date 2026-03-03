#!/usr/bin/env node
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

async function main() {
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  
  const apiCalls = []
  
  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('gate') && url.includes('/api')) {
      try {
        if (response.headers()['content-type']?.includes('json')) {
          const json = await response.json()
          apiCalls.push({ url, data: json })
          console.log(`📡 ${url}`)
          if (json.data) {
            const sample = Array.isArray(json.data) ? json.data[0] : json.data
            if (sample) {
              console.log(`   Keys: ${Object.keys(sample).join(', ')}`)
            }
          }
        }
      } catch (e) {}
    }
  })
  
  // Try different URL patterns for trader detail
  const traderIds = ['cta_gateusere5695293', '12345']
  const patterns = [
    (id) => `https://www.gate.com/copy-trading/${id}`,
    (id) => `https://www.gate.io/copy-trading/${id}`,
    (id) => `https://www.gate.com/futures/trader/${id}`,
    (id) => `https://www.gate.com/en/copy-trading/trader/${id}`,
  ]
  
  for (const pattern of patterns) {
    const url = pattern(traderIds[0])
    console.log(`\n🔍 Trying: ${url}`)
    
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 })
      console.log(`   Final URL: ${page.url()}`)
      await new Promise(r => setTimeout(r, 2000))
      
      if (apiCalls.length > 0) {
        console.log(`   ✅ Found ${apiCalls.length} API calls`)
        break
      }
    } catch (e) {
      console.log(`   ❌ ${e.message}`)
    }
  }
  
  console.log(`\n📋 Total API calls: ${apiCalls.length}`)
  apiCalls.forEach(c => console.log(`   ${c.url}`))
  
  await browser.close()
}

main().catch(console.error)
