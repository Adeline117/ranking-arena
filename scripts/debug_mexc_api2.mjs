#!/usr/bin/env node
import puppeteer from 'puppeteer'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  // Log ALL API URLs
  page.on('response', async response => {
    const url = response.url()
    if (!url.includes('mexc.com')) return
    const ct = response.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    try {
      const data = await response.json()
      // Look for any array with trader-like data
      const findArrays = (obj, path = '') => {
        if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') {
          const keys = Object.keys(obj[0])
          if (keys.some(k => ['nickname','nickName','roi','winRate','uid','traderId'].includes(k))) {
            const shortUrl = url.split('?')[0].split('/').slice(-3).join('/')
            console.log(`\n🎯 ${shortUrl} [${path}] - ${obj.length} items, keys: ${keys.slice(0,10).join(',')}`)
            if (obj[0].nickname || obj[0].nickName) {
              console.log(`  First: ${obj[0].nickname || obj[0].nickName}, wr=${obj[0].winRate}, mdd=${obj[0].maxDrawdown || obj[0].maxDrawdown7}`)
            }
          }
        }
        if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            findArrays(v, path ? `${path}.${k}` : k)
          }
        }
      }
      findArrays(data)
    } catch {}
  })

  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
  await sleep(5000)

  // Close popups
  await page.evaluate(() => {
    document.querySelectorAll('button, [class*="close"]').forEach(el => {
      const text = (el.textContent || '').trim()
      if (['关闭','OK','Got it','确定','Close','I understand','知道了'].some(t => text.includes(t))) {
        try { el.click() } catch {}
      }
    })
  })
  await sleep(2000)

  console.log('\n--- Clicking All Traders tab ---')
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const text = (el.textContent||'').trim()
      if (text === 'All Traders' || text === '全部交易员') {
        el.click()
        console.log('clicked:', text)
        return true
      }
    }
    return false
  })
  await sleep(5000)

  console.log('\n--- Scrolling down ---')
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000))
    await sleep(2000)
  }

  // Take a screenshot to see the page
  await page.screenshot({ path: '/Users/adelinewen/ranking-arena/debug_mexc.png', fullPage: false })
  console.log('\n📸 Screenshot saved')
  
  // Print page content structure
  const structure = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], [class*="tab"]')).map(t => t.textContent?.trim()).filter(Boolean)
    const pagination = document.querySelector('[class*="pagi"]')
    return { tabs: tabs.slice(0, 10), hasPagination: !!pagination, url: location.href }
  })
  console.log('Page structure:', JSON.stringify(structure))

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
