#!/usr/bin/env node
/**
 * SSR/DOM 数据提取 — 用于 JSON 拦截不到的平台
 * 真实 Chrome + DOM evaluate 直接从页面提取
 * 用法: node browser-ssr.mjs <platform>
 */
import { readFileSync } from 'fs'
import { execSync, spawn } from 'child_process'
import { chromium } from 'playwright'
import { clip, cs, sb, sleep } from './lib/index.mjs'

const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/snap/bin/chromium')

const PORT = 9334

async function launchChrome() {
  try { execSync('pkill -f "remote-debugging-port=9334"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-ssr-profile',
    '--no-first-run','--no-default-browser-check','--disable-background-networking',
    '--disable-default-apps','--disable-extensions','--disable-sync','--disable-gpu',
    '--window-size=1200,900','--window-position=9999,9999',
    '--proxy-server=http://127.0.0.1:7890','about:blank',
  ], { stdio: 'ignore', detached: true })
  chrome.unref()
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch {}
  }
  throw new Error('Chrome timeout')
}

async function extractFromPage(page) {
  return page.evaluate(() => {
    const results = []
    
    // Strategy 1: __NEXT_DATA__
    const nd = document.getElementById('__NEXT_DATA__')
    if (nd) {
      try {
        const data = JSON.parse(nd.textContent)
        const search = (obj, depth = 0) => {
          if (depth > 6 || !obj) return
          if (Array.isArray(obj) && obj.length >= 2) {
            for (const item of obj) {
              if (item && typeof item === 'object') {
                const keys = Object.keys(item)
                const hasTrader = keys.some(k => /trader|uid|leader|address|portfolio|userId|nick/i.test(k))
                const hasMetric = keys.some(k => /roi|pnl|yield|profit|winRate|return|income/i.test(k))
                if (hasTrader && hasMetric) results.push({ _src: 'next_data', ...item })
              }
            }
          }
          if (typeof obj === 'object' && !Array.isArray(obj)) {
            for (const v of Object.values(obj)) search(v, depth + 1)
          }
        }
        search(data)
      } catch {}
    }
    
    // Strategy 2: window.__INITIAL_STATE__ or similar
    for (const key of ['__INITIAL_STATE__', '__NUXT__', '__APP_DATA__', '__PRELOADED_STATE__']) {
      if (window[key]) {
        try {
          const search = (obj, depth = 0) => {
            if (depth > 6 || !obj) return
            if (Array.isArray(obj) && obj.length >= 2) {
              for (const item of obj) {
                if (item && typeof item === 'object') {
                  const keys = Object.keys(item)
                  const hasMetric = keys.some(k => /roi|pnl|yield|profit|winRate|return/i.test(k))
                  if (hasMetric) results.push({ _src: key, ...item })
                }
              }
            }
            if (typeof obj === 'object' && !Array.isArray(obj)) {
              for (const v of Object.values(obj)) search(v, depth + 1)
            }
          }
          search(window[key])
        } catch {}
      }
    }
    
    // Strategy 3: Script tags with JSON data
    for (const s of document.querySelectorAll('script:not([src])')) {
      const t = s.textContent
      if (t.length > 200 && t.length < 5000000 && (t.includes('roi') || t.includes('pnl') || t.includes('profit'))) {
        try {
          // Try to find JSON in script
          const match = t.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
          if (match) {
            const data = JSON.parse(match[0])
            const search = (obj, depth = 0) => {
              if (depth > 4 || !obj) return
              if (Array.isArray(obj)) {
                for (const item of obj) {
                  if (item && typeof item === 'object') {
                    const keys = Object.keys(item)
                    if (keys.some(k => /roi|pnl|profit/i.test(k))) results.push({ _src: 'script', ...item })
                  }
                }
              }
              if (typeof obj === 'object' && !Array.isArray(obj)) {
                for (const v of Object.values(obj)) search(v, depth + 1)
              }
            }
            search(data)
          }
        } catch {}
      }
    }
    
    // Strategy 4: DOM extraction — find trader cards
    if (results.length === 0) {
      const cards = document.querySelectorAll('[class*="trader" i], [class*="card" i], [class*="item" i], [class*="row" i], [class*="list" i] > div')
      const seen = new Set()
      for (const card of cards) {
        const text = card.innerText?.trim()
        if (!text || text.length < 20 || text.length > 2000) continue
        // Look for percentage patterns
        const pcts = text.match(/[+-]?\d+\.?\d*%/g) || []
        if (pcts.length === 0) continue
        // Extract name (usually first line or prominent text)
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
        const name = lines[0]?.substring(0, 50) || ''
        if (seen.has(name)) continue
        seen.add(name)
        // Find ROI (usually largest percentage)
        const nums = pcts.map(p => parseFloat(p))
        const roi = nums.sort((a, b) => Math.abs(b) - Math.abs(a))[0]
        results.push({ _src: 'dom', name, roi, pcts, text: text.substring(0, 200) })
      }
    }
    
    return results
  })
}

function parseTrader(item) {
  let id = '', name = '', roi = null, pnl = null, wr = null, dd = null
  
  for (const k of ['traderId','traderUid','uid','leaderId','encryptedUid','leadPortfolioId','copyTradeId','leaderMark','userId','trader_id','address','id']) {
    if (item[k] != null && String(item[k]).length > 1) { id = String(item[k]); break }
  }
  name = item.nickName || item.nickname || item.leaderName || item.name || item.displayName || ''
  
  if (item._src === 'dom') {
    // DOM extraction
    id = item.name || 'dom_' + Math.random().toString(36).slice(2, 10)
    name = item.name || ''
    roi = typeof item.roi === 'number' ? item.roi : null
  } else {
    for (const k of ['yieldRate','roi','roiRate','totalRoi','pnlRate','returnRate','periodRoi','copyTradeRoi','incomeRate']) {
      if (item[k] != null) { roi = parseFloat(item[k]); if (Math.abs(roi) < 20 && roi !== 0 && k !== 'roi') roi *= 100; break }
    }
    for (const k of ['totalProfit','profit','pnl','totalPnl','income']) { if (item[k] != null) { pnl = parseFloat(item[k]); break } }
    for (const k of ['winRate','win_rate','winRatio']) { if (item[k] != null) { wr = parseFloat(item[k]); if (wr > 0 && wr <= 1) wr *= 100; break } }
    for (const k of ['maxDrawDown','maxDrawdown','mdd','drawDown']) { if (item[k] != null) { dd = Math.abs(parseFloat(item[k])); if (dd > 0 && dd < 1) dd *= 100; break } }
  }
  
  if (!id && !name) return null
  if (!id) id = name
  return { id, name, roi, pnl, wr, dd }
}

const PLATFORMS = {
  bingx:  { url: 'https://bingx.com/en/copy-trading/', source: 'bingx', scroll: 10 },
  blofin: { url: 'https://blofin.com/en/copy-trade', source: 'blofin', scroll: 8 },
  // Also try to get more from low-count platforms
  bybit:  { url: 'https://www.bybit.com/copyTrade/', source: 'bybit', scroll: 15 },
  bitget_f: { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', source: 'bitget_futures', scroll: 15 },
  phemex: { url: 'https://phemex.com/copy-trading', source: 'phemex', scroll: 10 },
}

const name = process.argv[2]
if (!PLATFORMS[name]) { console.log('❌ unknown: ' + name + '. Options: ' + Object.keys(PLATFORMS).join(',')); process.exit(1) }
const cfg = PLATFORMS[name]

async function main() {
  await launchChrome()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const context = browser.contexts()[0] || await browser.newContext()
  const page = await context.newPage()
  
  // Also intercept JSON (belt and suspenders)
  const jsonTraders = new Map()
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const d = await res.json()
      const search = (obj, depth = 0) => {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj) && obj.length >= 2) {
          for (const it of obj) {
            if (!it || typeof it !== 'object') continue
            const t = parseTrader(it)
            if (t && t.id) jsonTraders.set(t.id, t)
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) for (const v of Object.values(obj)) search(v, depth + 1)
      }
      search(d)
    } catch {}
  })

  try {
    await page.goto(cfg.url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})

    // CF wait
    let cfOk = false
    for (let i = 0; i < 30; i++) {
      const t = await page.title().catch(() => '')
      if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
      await sleep(1500)
    }
    if (!cfOk) { console.log('❌ CF'); return }

    await sleep(8000)

    // Heavy scrolling to trigger lazy loads
    for (let i = 0; i < (cfg.scroll || 10); i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
      await sleep(2000)
      // Also try clicking "load more" buttons
      if (i % 3 === 0) {
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, a, div[role="button"]')]
          const loadMore = btns.find(b => /more|load|next|下一页|查看更多|展开/i.test(b.textContent))
          if (loadMore) loadMore.click()
        }).catch(()=>{})
      }
    }

    // Extract from DOM
    const domResults = await extractFromPage(page)
    console.log(`DOM: ${domResults.length} raw items`)
    
    // Combine JSON intercept + DOM
    const allTraders = new Map(jsonTraders)
    for (const item of domResults) {
      const t = parseTrader(item)
      if (t && t.id && !allTraders.has(t.id)) allTraders.set(t.id, t)
    }
    
    console.log(`JSON: ${jsonTraders.size}, DOM: ${domResults.length}, Combined: ${allTraders.size}`)

    if (allTraders.size > 0) {
      const traders = [...allTraders.values()]
      const now = new Date().toISOString()
      let saved = 0
      for (let i=0;i<traders.length;i+=50) try{await sb.from('trader_sources').upsert(traders.slice(i,i+50).map(t=>({source:cfg.source,source_trader_id:t.id,handle:t.name||t.id,market_type:'futures',is_active:true})),{onConflict:'source,source_trader_id'})}catch{}
      for (let i=0;i<traders.length;i+=30){const{error}=await sb.from('trader_snapshots').upsert(traders.slice(i,i+30).map((t,j)=>({source:cfg.source,source_trader_id:t.id,season_id:'30D',rank:i+j+1,roi:t.roi,pnl:t.pnl,win_rate:t.wr,max_drawdown:t.dd,arena_score:cs(t.roi,t.pnl,t.dd,t.wr),captured_at:now})),{onConflict:'source,source_trader_id,season_id'});if(!error)saved+=Math.min(30,traders.length-i)}
      console.log(`✅ ${saved}`)
    } else {
      console.log('❌ 0')
    }

    await page.close().catch(()=>{})
    browser.close().catch(()=>{})
  } finally {
    try { execSync('pkill -f "remote-debugging-port=9334"', { stdio: 'ignore' }) } catch {}
  }
}

main().then(() => process.exit(0)).catch(e => { console.log('❌', e.message?.substring(0,50)); process.exit(1) })
