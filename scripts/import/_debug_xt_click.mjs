import { chromium } from 'playwright'
import { execSync, spawn } from 'child_process'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = 9342

async function main() {
  try { execSync('pkill -f "remote-debugging-port=9342"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  
  spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-debug3',
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
  
  let traderCount = 0
  page.on('response', async res => {
    const url = res.url()
    if (url.includes('copy-trade') && url.includes('leader')) {
      try {
        const json = await res.json()
        const count = (obj) => {
          if (!obj) return 0
          if (Array.isArray(obj)) return obj.reduce((s,i) => s + count(i), 0)
          if (obj.accountId) return 1
          let c = 0
          for (const k of ['result','data','list','items']) if (obj[k]) c += count(obj[k])
          return c
        }
        const c = count(json)
        if (c > traderCount) {
          traderCount = c
          console.log(`API traders: ${c}`)
        }
      } catch {}
    }
  })
  
  console.log('Loading...')
  await page.goto('https://www.xt.com/en/copy-trading/futures', { timeout: 60000, waitUntil: 'load' })
  
  for (let i = 0; i < 30; i++) {
    const t = await page.title()
    if (!t.includes('moment') && !t.includes('Verify') && t.length > 5) break
    await sleep(1500)
  }
  console.log('CF OK')
  await sleep(6000)
  
  // Find and click All Traders using JavaScript
  console.log('Finding All Traders tab...')
  const clicked = await page.evaluate(() => {
    // Find element containing "All Traders" text
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.trim() === 'All Traders') {
        const el = walker.currentNode.parentElement
        el.click()
        return `Clicked: ${el.tagName} ${el.className}`
      }
    }
    // Try by class
    const tabs = document.querySelectorAll('[class*="tab"]')
    for (const tab of tabs) {
      if (tab.textContent?.includes('All Traders')) {
        tab.click()
        return `Clicked tab: ${tab.className}`
      }
    }
    return 'Not found'
  })
  console.log(clicked)
  await sleep(8000)
  
  // Count trader cards
  const cards = await page.evaluate(() => {
    const all = document.querySelectorAll('*')
    let count = 0
    for (const el of all) {
      const text = el.textContent || ''
      if (text.includes('%') && text.includes('Follow') && el.querySelectorAll('*').length < 50) {
        count++
      }
    }
    return count
  })
  console.log(`Cards found: ${cards}`)
  console.log(`API traders: ${traderCount}`)
  
  await browser.close()
  execSync('pkill -f "remote-debugging-port=9342"', { stdio: 'ignore' })
}

main().catch(e => console.log('Error:', e.message))
