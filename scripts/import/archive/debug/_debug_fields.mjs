#!/usr/bin/env node
/**
 * Debug: 抓取平台 JSON 响应，打印所有字段名和样本值
 * 用于发现各平台的真实字段映射
 * 用法: node _debug_fields.mjs <platform>
 */
import { readFileSync } from 'fs'
import { chromium } from 'playwright'
import { execSync, spawn } from 'child_process'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const PLATFORMS = {
  xt:       { url: 'https://www.xt.com/en/copy-trading/futures' },
  coinex:   { url: 'https://www.coinex.com/copy-trading' },
  kucoin:   { url: 'https://www.kucoin.com/copy-trading/leaderboard' },
  bybit:    { url: 'https://www.bybit.com/copyTrade/' },
  bitget_f: { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0' },
  mexc:     { url: 'https://www.mexc.com/copy-trading' },
  bingx:    { url: 'https://bingx.com/en/copy-trading/' },
  dydx:     { url: 'https://trade.dydx.exchange/portfolio/leaderboard' },
  phemex:   { url: 'https://phemex.com/copy-trading' },
  weex:     { url: 'https://www.weex.com/zh-CN/copy-trading' },
  lbank:    { url: 'https://www.lbank.com/copy-trading' },
}

const name = process.argv[2]
if (!PLATFORMS[name]) { console.log('Options:', Object.keys(PLATFORMS).join(',')); process.exit(1) }
const cfg = PLATFORMS[name]
const PORT = 9336

async function launchChrome() {
  try { execSync('pkill -f "remote-debugging-port=9336"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-debug-profile',
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

function findArrays(obj, path='', depth=0) {
  const results = []
  if (depth > 6 || !obj) return results
  if (Array.isArray(obj) && obj.length >= 2 && typeof obj[0] === 'object' && obj[0] !== null) {
    // Found an array of objects - this could be trader data
    const sample = obj[0]
    const keys = Object.keys(sample)
    results.push({ path, length: obj.length, keys, sample })
    return results // Don't recurse into arrays we've found
  }
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      results.push(...findArrays(v, path ? `${path}.${k}` : k, depth + 1))
    }
  }
  return results
}

async function main() {
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }).catch(()=>{})
  await sleep(500)
  
  await launchChrome()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const context = browser.contexts()[0] || await browser.newContext()
  const page = await context.newPage()
  
  const captured = []
  
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const url = res.url()
      if (url.includes('analytics')||url.includes('google')||url.includes('cdn-cgi')||url.includes('sentry')||url.includes('pixel')) return
      const d = await res.json()
      const arrays = findArrays(d)
      for (const arr of arrays) {
        if (arr.length >= 3) { // Only meaningful arrays
          captured.push({ url: url.substring(0, 120), ...arr })
        }
      }
    } catch {}
  })
  
  await page.goto(cfg.url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})
  
  // CF wait
  for (let i = 0; i < 25; i++) {
    const t = await page.title().catch(() => '')
    if (t && !t.includes('moment') && !t.includes('Check') && t.length > 3) break
    await sleep(1500)
  }
  
  await sleep(10000)
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
    await sleep(2000)
  }
  
  console.log(`\n📊 ${name.toUpperCase()} — ${captured.length} arrays captured\n`)
  for (const c of captured) {
    console.log(`URL: ${c.url}`)
    console.log(`Path: ${c.path || 'root'} | Count: ${c.length}`)
    console.log(`Keys: ${c.keys.join(', ')}`)
    // Print sample with values
    const sample = c.sample
    const interesting = {}
    for (const [k,v] of Object.entries(sample)) {
      if (v === null || v === undefined) continue
      if (typeof v === 'object') interesting[k] = `[${Array.isArray(v)?'array:'+v.length:'object'}]`
      else if (typeof v === 'string' && v.length > 80) interesting[k] = v.substring(0,80)+'...'
      else interesting[k] = v
    }
    console.log(`Sample: ${JSON.stringify(interesting)}`)
    console.log('---')
  }
  
  await page.close().catch(()=>{})
  browser.close().catch(()=>{})
  try { execSync('pkill -f "remote-debugging-port=9336"', { stdio: 'ignore' }) } catch {}
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }).catch(()=>{})
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e.message); process.exit(1) })
