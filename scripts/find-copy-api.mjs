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
    if (url.includes('gate') && (url.includes('copy') || url.includes('leader') || url.includes('cta'))) {
      try {
        if (response.headers()['content-type']?.includes('json')) {
          const json = await response.json()
          apiCalls.push({ url, status: response.status(), data: json })
          console.log(`📡 ${response.status()} ${url}`)
          if (json.data) {
            if (Array.isArray(json.data) && json.data[0]) {
              console.log(`   Array[${json.data.length}], first item keys: ${Object.keys(json.data[0]).slice(0, 15).join(', ')}`)
            } else if (typeof json.data === 'object') {
              console.log(`   Object keys: ${Object.keys(json.data).slice(0, 15).join(', ')}`)
            }
          }
        }
      } catch (e) {}
    }
  })
  
  // Try to find copy trading page
  const urls = [
    'https://www.gate.io/zh/copy-trading',
    'https://www.gate.com/zh/copy-trading',
    'https://www.gate.io/copy_trading',
    'https://www.gate.com/copy_trading',
  ]
  
  for (const url of urls) {
    console.log(`\n🔍 Trying: ${url}`)
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 })
      console.log(`   Status: ${response.status()}, Final URL: ${page.url()}`)
      await new Promise(r => setTimeout(r, 3000))
      
      if (apiCalls.length > 0) {
        console.log(`   ✅ Found ${apiCalls.length} copy-related API calls!`)
        break
      }
    } catch (e) {
      console.log(`   ❌ ${e.message}`)
    }
  }
  
  console.log(`\n📋 Total API calls: ${apiCalls.length}`)
  apiCalls.forEach((c, i) => {
    console.log(`${i + 1}. [${c.status}] ${c.url}`)
  })
  
  await browser.close()
}

main().catch(console.error)
