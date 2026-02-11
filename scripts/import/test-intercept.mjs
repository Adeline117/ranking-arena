#!/usr/bin/env node
/**
 * Quick test: load a platform page, intercept ALL JSON responses, dump them
 */
import { execSync, spawn } from 'child_process'
import { chromium } from 'playwright'
import { sleep } from './lib/index.mjs'

const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/snap/bin/chromium')

const PORT = 9338
const url = process.argv[2] || 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0'

try { execSync(`pkill -f "remote-debugging-port=${PORT}"`, { stdio: 'ignore' }) } catch {}
await sleep(2000)

spawn(CHROME_PATH, [
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-test-profile',
  '--no-first-run','--disable-extensions','--disable-sync','--disable-gpu',
  '--window-size=1200,900',
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

const allResponses = []
page.on('response', async res => {
  try {
    const ct = res.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    const u = res.url()
    if (u.includes('analytics')||u.includes('google')||u.includes('cdn-cgi')||
        u.includes('sentry')||u.includes('pixel')||u.includes('tingyun')) return
    const d = await res.json()
    const keys = typeof d === 'object' && !Array.isArray(d) ? Object.keys(d).join(',') : 'array'
    // Check if there's any array with >3 objects
    let maxArr = 0
    function findArr(o, depth=0) {
      if (depth>5) return
      if (Array.isArray(o)) { if (o.length > maxArr && o[0] && typeof o[0]==='object') maxArr = o.length }
      else if (typeof o === 'object' && o) { for (const v of Object.values(o)) findArr(v, depth+1) }
    }
    findArr(d)
    allResponses.push({ url: u.substring(0,100), keys, maxArr })
    if (maxArr >= 3) {
      console.log(`\n🔥 ${u.substring(0,100)} → maxArr=${maxArr}`)
      // Show first item's keys
      function getFirstArr(o, depth=0) {
        if (depth>5) return null
        if (Array.isArray(o) && o.length >= 3 && typeof o[0]==='object') return o
        if (typeof o === 'object' && o) for (const v of Object.values(o)) { const r = getFirstArr(v,depth+1); if(r)return r }
        return null
      }
      const arr = getFirstArr(d)
      if (arr) {
        console.log(`  First item keys: ${Object.keys(arr[0]).join(', ')}`)
        console.log(`  Sample: ${JSON.stringify(arr[0]).substring(0,300)}`)
      }
    }
  } catch {}
})

console.log('Loading', url)
await page.goto(url, { timeout: 60000, waitUntil: 'load' }).catch(e => console.log('goto err:', e.message))

// CF wait
for (let i = 0; i < 30; i++) {
  const t = await page.title().catch(() => '')
  if (t && !t.includes('moment') && !t.includes('Check') && t.length > 3) { console.log('CF OK, title:', t); break }
  await sleep(1500)
}

// Wait for content
await sleep(15000)

// Scroll
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
  await sleep(2000)
}

console.log('\n\nAll responses:')
for (const r of allResponses) {
  console.log(`  ${r.url} maxArr=${r.maxArr}`)
}

// Check DOM for trader cards
const domInfo = await page.evaluate(() => {
  const cards = document.querySelectorAll('[class*="trader"], [class*="leader"], [class*="card"]')
  const links = [...document.querySelectorAll('a')].filter(a => /trader|leader|copy/.test(a.href))
  return { cards: cards.length, links: links.length, bodyLen: document.body?.innerText?.length }
}).catch(() => ({}))
console.log('\nDOM:', domInfo)

await ctx.close()
try { execSync(`pkill -f "remote-debugging-port=${PORT}"`, { stdio: 'ignore' }) } catch {}
process.exit(0)
