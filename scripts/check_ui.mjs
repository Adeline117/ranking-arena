import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
puppeteer.use(StealthPlugin())

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })

  console.log('1. 访问首页...')
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 3000))
  await page.screenshot({ path: '/tmp/ui_homepage.png', fullPage: false })
  console.log('   截图: /tmp/ui_homepage.png')

  console.log('2. 访问 30D 排行榜...')
  await page.goto('http://localhost:3000?window=30d', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 3000))
  await page.screenshot({ path: '/tmp/ui_30d.png', fullPage: false })
  console.log('   截图: /tmp/ui_30d.png')

  await browser.close()
  console.log('\n✅ UI 截图完成')
}

main().catch(console.error)
