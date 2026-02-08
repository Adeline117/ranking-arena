// Click "All Traders" and see what API is called
import { chromium } from 'playwright'
import { execSync, spawn } from 'child_process'

const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/snap/bin/chromium')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = 9341

async function main() {
  try { execSync('pkill -f "remote-debugging-port=9341"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  
  spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-debug2',
    '--no-first-run','--disable-extensions','--window-size=1400,900',
    '--proxy-server=http://127.0.0.1:7890', 'about:blank',
  ], { stdio: 'ignore', detached: true }).unref()
  
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}
  }
  
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0]
  const page = await ctx.newPage()
  
  const apis = []
  page.on('response', async res => {
    const url = res.url()
    if (url.includes('copy-trade') || url.includes('trader') || url.includes('leader')) {
      const ct = res.headers()['content-type'] || ''
      if (ct.includes('json')) {
        try {
          const json = await res.json()
          const str = JSON.stringify(json)
          apis.push({ url: url.split('?')[0].split('/').slice(-2).join('/'), params: new URL(url).search, size: str.length })
          
          // Check for trader data
          const countTraders = (obj) => {
            if (!obj) return 0
            if (Array.isArray(obj)) return obj.reduce((sum, item) => sum + countTraders(item), 0)
            if (typeof obj === 'object') {
              if (obj.accountId || obj.traderId) return 1
              let count = 0
              for (const key of ['result', 'data', 'list', 'items']) {
                if (obj[key]) count += countTraders(obj[key])
              }
              return count
            }
            return 0
          }
          const count = countTraders(json)
          if (count > 0) console.log(`  API: ${url.split('/').slice(-1)[0].split('?')[0]} → ${count} traders`)
        } catch {}
      }
    }
  })
  
  console.log('Loading XT...')
  await page.goto('https://www.xt.com/en/copy-trading/futures', { timeout: 60000 }).catch(()=>{})
  
  // Wait for CF
  for (let i = 0; i < 40; i++) {
    const t = await page.title()
    if (!t.includes('moment') && !t.includes('Verify') && t.length > 5) break
    await sleep(1000)
  }
  console.log('CF passed')
  await sleep(5000)
  
  // Click "All Traders"
  console.log('\nClicking "All Traders"...')
  try {
    await page.click('text=All Traders', { timeout: 5000 })
    console.log('Clicked!')
  } catch (e) {
    console.log('Click failed, trying other selectors...')
    try { await page.click('div:has-text("All Traders"):not(:has(div))') } catch {}
  }
  
  await sleep(8000)
  
  // Check trader count
  const cards = await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="follow"]')
    return Array.from(cards).filter(c => c.textContent?.includes('%')).length
  })
  console.log(`\nTrader cards after click: ${cards}`)
  
  // Try scrolling
  console.log('\nScrolling...')
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)
  }
  
  const cardsAfter = await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="follow"]')
    return Array.from(cards).filter(c => c.textContent?.includes('%')).length
  })
  console.log(`Trader cards after scroll: ${cardsAfter}`)
  
  console.log('\n=== All API calls ===')
  apis.forEach(a => console.log(`${a.url}${a.params} (${a.size}b)`))
  
  await browser.close()
  execSync('pkill -f "remote-debugging-port=9341"', { stdio: 'ignore' })
}

main().catch(e => console.log('Error:', e.message))
