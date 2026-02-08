#!/usr/bin/env node
import { execSync, spawn } from 'child_process'
import { chromium } from 'playwright'

const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/snap/bin/chromium')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = 9338
try { execSync(`pkill -f "remote-debugging-port=${PORT}"`, { stdio: 'ignore' }) } catch {}
await sleep(2000)

spawn(CHROME_PATH, [
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-test-profile',
  '--no-first-run','--disable-extensions','--disable-sync','--disable-gpu',
  '--proxy-server=http://127.0.0.1:7890','about:blank',
], { stdio: 'ignore', detached: true }).unref()

for (let i = 0; i < 25; i++) {
  await sleep(500)
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
const ctx = browser.contexts()[0] || await browser.newContext()
const page = await ctx.newPage()
await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm,ico}', r => r.abort())

let traderData = null
page.on('response', async res => {
  try {
    if (!res.url().includes('traderViewV3')) return
    const d = await res.json()
    traderData = d
  } catch {}
})

await page.goto('https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', { timeout: 60000, waitUntil: 'load' }).catch(()=>{})
for (let i = 0; i < 30; i++) {
  const t = await page.title().catch(() => '')
  if (t && !t.includes('moment')) break
  await sleep(1500)
}
await sleep(15000)

if (traderData) {
  // Show full structure of first trader
  const data = traderData.data || traderData.result || traderData
  const list = Array.isArray(data) ? data : data.list || data.items || data.traderList || []
  if (list.length > 0) {
    console.log('=== FULL FIRST TRADER ===')
    console.log(JSON.stringify(list[0], null, 2))
    console.log('\n=== TOP-LEVEL KEYS ===')
    console.log(Object.keys(list[0]))
  } else {
    console.log('Response structure:', JSON.stringify(traderData).substring(0, 2000))
  }
} else {
  console.log('No traderViewV3 response caught!')
}

await ctx.close()
try { execSync(`pkill -f "remote-debugging-port=${PORT}"`, { stdio: 'ignore' }) } catch {}
process.exit(0)
