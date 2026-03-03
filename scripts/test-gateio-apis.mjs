#!/usr/bin/env node
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

async function main() {
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  
  const apiEndpoints = [
    'https://www.gate.io/apiw/v1/copytrade/leader/list?sort=roi&period=30d&page=1&limit=10',
    'https://www.gate.io/api/copytrade/leader/list?sort=roi&period=30d&page=1&limit=10',
    'https://www.gate.io/apiw/v2/copy_trading/leaders?sort_by=roi&period=30d&page=1&page_size=10',
  ]
  
  for (const url of apiEndpoints) {
    console.log(`\n🔍 Testing: ${url}`)
    
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 })
      const status = response.status()
      const contentType = response.headers()['content-type'] || ''
      
      console.log(`   Status: ${status}, ContentType: ${contentType}`)
      
      if (contentType.includes('json')) {
        const text = await response.text()
        const json = JSON.parse(text)
        
        console.log(`   Response keys: ${Object.keys(json).join(', ')}`)
        
        if (json.data) {
          const list = Array.isArray(json.data) ? json.data : (json.data.list || json.data.rows || [])
          console.log(`   Data length: ${list.length}`)
          
          if (list.length > 0) {
            console.log(`   ✅ GOT DATA!`)
            console.log(`   First item:`, JSON.stringify(list[0], null, 2))
            break
          }
        }
      }
    } catch (e) {
      console.log(`   ❌ Error: ${e.message}`)
    }
  }
  
  await browser.close()
}

main().catch(console.error)
