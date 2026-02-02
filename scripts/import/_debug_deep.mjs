#!/usr/bin/env node
/**
 * Deep debug: 记录所有 JSON 响应（包含3+对象的数组），找到 trader 数据
 */
import { execSync, spawn } from 'child_process'
import { chromium } from 'playwright'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = 9336

async function launchChrome() {
  try { execSync('pkill -f "remote-debugging-port=9336"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-debug2-profile',
    '--no-first-run','--disable-extensions','--disable-sync','--disable-gpu',
    '--window-size=1200,900','--window-position=9999,9999',
    '--proxy-server=http://127.0.0.1:7890','about:blank',
  ], { stdio: 'ignore', detached: true }).unref()
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch {}
  }
  throw new Error('Chrome timeout')
}

const url = process.argv[2] || 'https://www.xt.com/en/copy-trading/futures'

async function main() {
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }).catch(()=>{})
  await sleep(500)
  await launchChrome()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0] || await browser.newContext()
  const page = await ctx.newPage()
  
  // Log ALL responses with their body structure
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const url = res.url()
      if (url.includes('analytics')||url.includes('google')||url.includes('cdn-cgi')||url.includes('sentry')||url.includes('pixel')||url.includes('market/v1/public')||url.includes('symbol')||url.includes('ticker')||url.includes('currency')||url.includes('mark-price')||url.includes('lang/available')||url.includes('etf/symbol')) return
      const text = await res.text()
      if (text.length < 50) return
      // Print URL and first 1000 chars of body
      console.log(`\n>>> ${url.substring(0,120)}`)
      console.log(`  size: ${text.length} bytes`)
      console.log(`  body: ${text.substring(0, 1500)}`)
    } catch(e) { /* ignore */ }
  })
  
  await page.goto(url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})
  
  for (let i = 0; i < 25; i++) {
    const t = await page.title().catch(() => '')
    if (t && !t.includes('moment') && !t.includes('Check') && t.length > 3) { console.log('CF ✅'); break }
    await sleep(1500)
  }
  
  await sleep(12000)
  
  // Also check __NEXT_DATA__ and window state
  const nextData = await page.evaluate(() => {
    const nd = document.getElementById('__NEXT_DATA__')
    if (nd) return nd.textContent.substring(0, 3000)
    return null
  }).catch(() => null)
  if (nextData) console.log('\n>>> __NEXT_DATA__:\n', nextData)
  
  const windowState = await page.evaluate(() => {
    const keys = []
    for (const k of Object.keys(window)) {
      if (k.startsWith('__') && typeof window[k] === 'object') keys.push(k)
    }
    return keys
  }).catch(() => [])
  console.log('\n>>> Window state keys:', windowState.join(', '))
  
  // Scroll and capture more
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
    await sleep(3000)
  }
  
  await page.close().catch(()=>{})
  browser.close().catch(()=>{})
  try { execSync('pkill -f "remote-debugging-port=9336"', { stdio: 'ignore' }) } catch {}
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }).catch(()=>{})
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e.message); process.exit(1) })
