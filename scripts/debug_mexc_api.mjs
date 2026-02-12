#!/usr/bin/env node
import puppeteer from 'puppeteer'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  page.on('response', async response => {
    const url = response.url()
    if (url.includes('copy') || url.includes('trader') || url.includes('rank') || url.includes('leader')) {
      try {
        const ct = response.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const data = await response.json()
        let list = data?.data?.list || data?.data?.items || data?.data?.traders || data?.list || []
        if (data?.data && Array.isArray(data.data)) list = data.data
        if (!Array.isArray(list) || list.length === 0) return
        
        const shortUrl = url.split('?')[0].split('/').slice(-3).join('/')
        console.log(`\n📡 ${shortUrl} - ${list.length} items`)
        // Print first item's keys and sample values
        const sample = list[0]
        const keys = Object.keys(sample)
        console.log(`  Keys: ${keys.join(', ')}`)
        console.log(`  Sample:`, JSON.stringify(sample, null, 2).substring(0, 500))
        
        // Check how many have winRate
        const withWr = list.filter(i => i.winRate != null && i.winRate !== '').length
        const withNickname = list.filter(i => i.nickName || i.nickname || i.name || i.displayName).length
        console.log(`  withWR: ${withWr}, withNickname: ${withNickname}`)
      } catch {}
    }
  })

  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
  await sleep(8000)
  
  // Close popups
  await page.evaluate(() => {
    document.querySelectorAll('button, [class*="close"], [class*="modal"] *').forEach(el => {
      const text = (el.textContent || '').trim()
      if (['关闭','OK','Got it','确定','Close','I understand','知道了'].some(t => text.includes(t))) {
        try { el.click() } catch {}
      }
    })
  })
  await sleep(2000)

  // Click All Traders
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, [role="tab"], [class*="tab"], span, div')) {
      if (['All Traders', '全部交易员'].includes((el.textContent||'').trim())) { el.click(); return }
    }
  })
  await sleep(5000)
  
  console.log('\n--- Done capturing initial load ---')
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
