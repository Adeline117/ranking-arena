import { chromium } from 'playwright'
import { execSync, spawn } from 'child_process'

const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/snap/bin/chromium')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = 9350

async function main() {
  console.log('Testing Binance with real Chrome + proxy...')
  
  // Kill existing
  try { execSync('pkill -f "remote-debugging-port=9350"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  
  // Launch Chrome with proxy
  spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/chrome-binance-test',
    '--no-first-run', '--disable-extensions',
    '--window-size=1400,900',
    '--proxy-server=http://127.0.0.1:7890',
    'about:blank',
  ], { stdio: 'ignore', detached: true }).unref()
  
  // Wait for Chrome
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) break
    } catch {}
  }
  
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0]
  const page = await ctx.newPage()
  
  // Get IP
  await page.goto('https://api.ipify.org?format=json')
  const ip = await page.textContent('body')
  console.log('IP:', ip)
  
  // Try Binance
  let traders = []
  page.on('response', async res => {
    const url = res.url()
    if (url.includes('copy-trade') && url.includes('list')) {
      try {
        const json = await res.json()
        console.log('API Response:', json.code, json.success, json.data?.list?.length || 0)
        if (json.data?.list) traders.push(...json.data.list)
      } catch {}
    }
  })
  
  console.log('Loading Binance...')
  await page.goto('https://www.binance.com/en/copy-trading/futures', { timeout: 45000, waitUntil: 'load' }).catch(e => console.log('Nav:', e.message))
  
  await sleep(10000)
  
  console.log('Title:', await page.title())
  console.log('Traders found:', traders.length)
  
  // Check if blocked
  const content = await page.content()
  if (content.includes('restricted') || content.includes('unavailable')) {
    console.log('Page shows restriction message')
  }
  
  await browser.close()
  execSync('pkill -f "remote-debugging-port=9350"', { stdio: 'ignore' })
}

main().catch(e => console.log('Error:', e.message))
