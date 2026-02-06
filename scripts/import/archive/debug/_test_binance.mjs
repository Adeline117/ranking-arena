import { chromium } from 'playwright'

async function main() {
  console.log('Testing Binance with browser + proxy...')
  
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: 'http://127.0.0.1:7890' }
  })
  
  const page = await browser.newPage()
  
  // Get IP
  await page.goto('https://api.ipify.org?format=json')
  const ipText = await page.textContent('body')
  console.log('IP:', ipText)
  
  // Try Binance
  console.log('Loading Binance copy trading...')
  let traders = []
  
  page.on('response', async res => {
    const url = res.url()
    if (url.includes('copy-trade')) {
      try {
        const json = await res.json()
        console.log('API:', url.split('/').pop().split('?')[0], '→', json.code, json.success, json.data?.list?.length || 0)
        if (json.data?.list) traders.push(...json.data.list)
      } catch {}
    }
  })
  
  await page.goto('https://www.binance.com/en/copy-trading/futures', { waitUntil: 'networkidle', timeout: 45000 }).catch(e => console.log('Nav:', e.message))
  
  await new Promise(r => setTimeout(r, 8000))
  
  const title = await page.title()
  console.log('Title:', title)
  console.log('Traders:', traders.length)
  
  await browser.close()
}

main().catch(e => console.log('Error:', e.message))
