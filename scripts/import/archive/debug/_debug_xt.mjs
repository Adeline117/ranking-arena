// Quick debug script to see XT page structure
import { chromium } from 'playwright'
import { execSync, spawn } from 'child_process'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = 9340

async function main() {
  try { execSync('pkill -f "remote-debugging-port=9340"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  
  spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-debug',
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
  
  // Track all API calls
  const apis = []
  page.on('response', async res => {
    const url = res.url()
    if (url.includes('api') || url.includes('trader') || url.includes('copy') || url.includes('leader')) {
      const ct = res.headers()['content-type'] || ''
      if (ct.includes('json')) {
        try {
          const json = await res.json()
          const size = JSON.stringify(json).length
          apis.push({ url: url.split('?')[0], size })
        } catch {}
      }
    }
  })
  
  console.log('Loading XT...')
  await page.goto('https://www.xt.com/en/copy-trading/futures', { timeout: 60000, waitUntil: 'networkidle' }).catch(()=>{})
  await sleep(8000)
  
  // Print all clickable elements
  const buttons = await page.evaluate(() => {
    const results = []
    const els = document.querySelectorAll('button, a, div[class*="tab"], span[class*="tab"], div[role="button"]')
    els.forEach(el => {
      const text = el.textContent?.trim().slice(0, 50)
      if (text && text.length > 0 && text.length < 30) {
        results.push({ tag: el.tagName, text, cls: el.className?.slice(0, 50) || '' })
      }
    })
    return results.slice(0, 40)
  })
  
  console.log('\n=== Clickable elements ===')
  const seen = new Set()
  buttons.forEach(b => {
    if (!seen.has(b.text)) {
      seen.add(b.text)
      console.log(`${b.tag}: "${b.text}"`)
    }
  })
  
  console.log('\n=== API endpoints ===')
  apis.forEach(a => console.log(`${a.url} (${a.size}b)`))
  
  const cards = await page.evaluate(() => document.querySelectorAll('[class*="trader"], [class*="card"]').length)
  console.log(`\nTrader cards: ${cards}`)
  
  await browser.close()
  execSync('pkill -f "remote-debugging-port=9340"', { stdio: 'ignore' })
}

main().catch(e => console.log('Error:', e.message))
