import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

async function main() {
  console.log('启动浏览器...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })

  // 收集所有 API 请求
  const apiCalls = []

  page.on('response', async (response) => {
    const url = response.url()
    const ct = response.headers()['content-type'] || ''

    if (ct.includes('json') || url.includes('api') || url.includes('indexer')) {
      try {
        const data = await response.json()
        console.log('\n📡 API:', url.split('?')[0])
        console.log('   Keys:', Object.keys(data).slice(0, 8).join(', '))
        
        if (Array.isArray(data)) {
          console.log('   Array length:', data.length)
          if (data[0]) console.log('   Item keys:', Object.keys(data[0]).slice(0, 8).join(', '))
        }
        
        apiCalls.push({ url: url.split('?')[0], data })
      } catch {}
    }
  })

  console.log('\n访问 dydx.trade/leaderboard...')
  await page.goto('https://dydx.trade/leaderboard', { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise(r => setTimeout(r, 8000))

  await page.screenshot({ path: '/tmp/dydx_v4_leaderboard.png', fullPage: true })
  console.log('\n截图: /tmp/dydx_v4_leaderboard.png')

  const text = await page.evaluate(() => document.body.innerText)
  console.log('\n页面文本 (前 800 字符):')
  console.log(text.slice(0, 800))

  await browser.close()
}

main().catch(console.error)
