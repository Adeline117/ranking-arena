#!/usr/bin/env node
/**
 * 用真实 Chrome (非 Playwright Chromium) 抓取
 * 1. 启动真实 Chrome + remote-debugging
 * 2. 通过 CDP 连接
 * 3. CF 检测不到自动化指纹
 * 
 * 用法: node browser-real-chrome.mjs <platform>
 */
import { readFileSync } from 'fs'
import { execSync, spawn } from 'child_process'
import { chromium } from 'playwright'
import { clip, cs, extractTraders, sb, sleep } from './lib/index.mjs'

const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/snap/bin/chromium')

const PLATFORMS = {
  bybit:    { url: 'https://www.bybit.com/copyTrade/', source: 'bybit' },
  mexc:     { url: 'https://www.mexc.com/copy-trading', source: 'mexc' },
  kucoin:   { url: 'https://www.kucoin.com/copy-trading/leaderboard', source: 'kucoin' },
  bitget_f: { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', source: 'bitget_futures' },
  bitget_s: { url: 'https://www.bitget.com/copy-trading/spot', source: 'bitget_spot' },
  bingx:    { url: 'https://bingx.com/en/copy-trading/', source: 'bingx' },
  phemex:   { url: 'https://phemex.com/copy-trading', source: 'phemex' },
  weex:     { url: 'https://www.weex.com/zh-CN/copy-trading', source: 'weex' },
  lbank:    { url: 'https://www.lbank.com/copy-trading', source: 'lbank' },
  blofin:   { url: 'https://blofin.com/en/copy-trade', source: 'blofin' },
}

const name = process.argv[2]
if (!PLATFORMS[name]) { console.log('❌ unknown: ' + name); process.exit(1) }
const cfg = PLATFORMS[name]

const PORT = 9333

async function launchRealChrome() {
  // Kill any existing debug Chrome
  try { execSync('pkill -f "remote-debugging-port=9333"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)

  const chromePath = CHROME_PATH
  const userDataDir = '/tmp/chrome-scrape-profile'
  
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-gpu',
    '--window-size=1200,900',
    '--window-position=9999,9999',
    `--proxy-server=http://127.0.0.1:7890`,
    'about:blank',
  ], { stdio: 'ignore', detached: true })
  chrome.unref()

  // Wait for Chrome to start
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return chrome
    } catch {}
  }
  throw new Error('Chrome launch timeout')
}

async function main() {
  const chrome = await launchRealChrome()
  const traders = new Map()
  let savedTotal = 0

  try {
    // Connect via CDP
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    const context = browser.contexts()[0] || await browser.newContext()
    const page = await context.newPage()

    // Intercept JSON responses
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const d = await res.json()
        const found = extractTraders(d)
        let newCount = 0
        for (const t of found) { if (!traders.has(t.id)) { traders.set(t.id, t); newCount++ } }
        if (newCount > 0 && traders.size - savedTotal >= 20) {
          const batch = [...traders.values()].slice(savedTotal)
          const now = new Date().toISOString()
          for (let i=0;i<batch.length;i+=50) try{await sb.from('trader_sources').upsert(batch.slice(i,i+50).map(t=>({source:cfg.source,source_trader_id:t.id,handle:t.name||t.id,avatar_url:t.avatar,market_type:'futures',is_active:true})),{onConflict:'source,source_trader_id'})}catch{}
          for (let i=0;i<batch.length;i+=30) try{await sb.from('trader_snapshots').upsert(batch.slice(i,i+30).map((t,j)=>({source:cfg.source,source_trader_id:t.id,season_id:'30D',rank:savedTotal+i+j+1,roi:t.roi,pnl:t.pnl,win_rate:t.wr,max_drawdown:t.dd,trades_count:t.trades,arena_score:cs(t.roi,t.pnl,t.dd,t.wr),captured_at:now})),{onConflict:'source,source_trader_id,season_id'})}catch{}
          savedTotal = traders.size
        }
      } catch {}
    })

    await page.goto(cfg.url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})

    // CF wait
    let cfOk = false
    for (let i = 0; i < 30; i++) {
      const t = await page.title().catch(() => '')
      if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
      await sleep(1500)
    }
    if (!cfOk) { console.log('❌ CF'); return }

    await sleep(10000)

    // Scroll
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
      await sleep(2000)
    }

    // Final save
    if (traders.size > savedTotal) {
      const batch = [...traders.values()].slice(savedTotal)
      const now = new Date().toISOString()
      for (let i=0;i<batch.length;i+=50) try{await sb.from('trader_sources').upsert(batch.slice(i,i+50).map(t=>({source:cfg.source,source_trader_id:t.id,handle:t.name||t.id,avatar_url:t.avatar,market_type:'futures',is_active:true})),{onConflict:'source,source_trader_id'})}catch{}
      for (let i=0;i<batch.length;i+=30) try{await sb.from('trader_snapshots').upsert(batch.slice(i,i+30).map((t,j)=>({source:cfg.source,source_trader_id:t.id,season_id:'30D',rank:savedTotal+i+j+1,roi:t.roi,pnl:t.pnl,win_rate:t.wr,max_drawdown:t.dd,trades_count:t.trades,arena_score:cs(t.roi,t.pnl,t.dd,t.wr),captured_at:now})),{onConflict:'source,source_trader_id,season_id'})}catch{}
      savedTotal = traders.size
    }

    console.log(savedTotal > 0 ? `✅ ${savedTotal}` : '❌ 0')
    await page.close().catch(()=>{})
    browser.close().catch(()=>{})
  } finally {
    try { execSync('pkill -f "remote-debugging-port=9333"', { stdio: 'ignore' }) } catch {}
  }
}

main().then(() => process.exit(0)).catch(e => { console.log('❌', e.message?.substring(0,50)); process.exit(1) })
