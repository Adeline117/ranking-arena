#!/usr/bin/env node
import puppeteer from 'puppeteer'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  let allTraders = []
  let v2Urls = []

  page.on('response', async response => {
    const url = response.url()
    if (url.includes('v1/traders/v2')) {
      try {
        const ct = response.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const data = await response.json()
        const list = data?.data?.content || []
        if (list.length > 0) {
          v2Urls.push(url)
          console.log(`\n📡 v2 URL: ${url}`)
          console.log(`  Items: ${list.length}, totalPages: ${data?.data?.totalPages}, totalElements: ${data?.data?.totalElements}`)
          allTraders.push(...list)
        }
      } catch {}
    }
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
  await sleep(1000)

  // Click All Traders
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.textContent||'').trim() === 'All Traders') { el.click(); return }
    }
  })
  await sleep(5000)

  // Now try to paginate by scrolling
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(3000)
    console.log(`Scroll ${i+1}, total traders: ${allTraders.length}`)
  }

  console.log(`\n\nTotal captured: ${allTraders.length}`)
  if (v2Urls.length > 0) {
    console.log('Sample URL:', v2Urls[0])
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
