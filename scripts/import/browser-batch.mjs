#!/usr/bin/env node
/**
 * 批量浏览器拦截 — 逐个平台，拦截 ALL JSON responses
 * 解决之前拦截规则太窄的问题
 */
import { chromium } from 'playwright'
import { sleep, extractTraders, save } from './lib/index.mjs'

const PLATFORMS = {
  bybit:    { url: 'https://www.bybit.com/copyTrade/', source: 'bybit' },
  kucoin:   { url: 'https://www.kucoin.com/copy-trading/leaderboard', source: 'kucoin' },
  xt:       { url: 'https://www.xt.com/en/copy-trading/futures', source: 'xt' },
  bingx:    { url: 'https://bingx.com/en/copy-trading/', source: 'bingx' },
  bitget:   { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', source: 'bitget_futures' },
  phemex:   { url: 'https://phemex.com/copy-trading', source: 'phemex' },
  weex:     { url: 'https://www.weex.com/zh-CN/copy-trading', source: 'weex' },
  lbank:    { url: 'https://www.lbank.com/copy-trading', source: 'lbank' },
  blofin:   { url: 'https://blofin.com/en/copy-trade', source: 'blofin' },
}

const targets = process.argv.slice(2).filter(p => PLATFORMS[p])
if (!targets.length) {
  console.log('Usage: node browser-batch.mjs <' + Object.keys(PLATFORMS).join('|') + '> [...]')
  process.exit(1)
}

async function runPlatform(browser, name) {
  const cfg = PLATFORMS[name]
  console.log(`\n📊 ${name.toUpperCase()}`)
  const traders = new Map()
  const allUrls = []
  
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm,ico}', r => r.abort())
  
  // Intercept ALL JSON responses
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const url = res.url()
      allUrls.push(url.substring(0, 100))
      const d = await res.json()
      const found = extractTraders(d)
      for (const t of found) {
        if (!traders.has(t.id)) traders.set(t.id, t)
      }
      if (found.length) process.stdout.write(`\r  拦截: ${traders.size}`)
    } catch {}
  })
  
  try {
    await page.goto(cfg.url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})
    
    // CF wait
    for (let i = 0; i < 25; i++) {
      const t = await page.title().catch(() => '')
      if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) {
        console.log(`  CF ✅`)
        break
      }
      if (i === 24) { console.log(`  CF ❌`); await ctx.close(); return }
      await sleep(1500)
    }
    
    // Wait for page to load data
    await sleep(10000)
    
    // Scroll to trigger lazy loading
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
      await sleep(2000)
    }
    
    const all = [...traders.values()]
    if (all.length) {
      const saved = await save(cfg.source, all)
      console.log(`\n  ✅ ${saved} 保存`)
    } else {
      console.log(`\n  ❌ 0 拦截 (${allUrls.length} JSON responses)`)
      // Print some URLs for debugging
      const interesting = allUrls.filter(u => !u.includes('analytics') && !u.includes('google') && !u.includes('pixel'))
      if (interesting.length) console.log(`  URLs: ${interesting.slice(0,5).join('\n        ')}`)
    }
  } finally {
    await ctx.close()
  }
}

async function main() {
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) })
  await sleep(500)
  
  const browser = await chromium.launch({
    headless: false, executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=400,300','--window-position=9999,9999','--disable-gpu','--disable-extensions','--disable-dev-shm-usage'],
  })
  
  try {
    for (const name of targets) {
      await runPlatform(browser, name)
    }
  } finally {
    await browser.close().catch(()=>{})
    await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) })
  }
}

main().catch(e => { console.error(e); process.exit(1) })
