#!/usr/bin/env node
/**
 * 全平台浏览器修复 — 逐个平台加载，debug JSON 响应，正确提取数据
 * 用法: node browser-fix-all.mjs [platform] [--debug]
 * 不传 platform 则跑全部
 */
import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { execSync, spawn } from 'child_process'
import { chromium } from 'playwright'

try { for (const l of readFileSync('.env.local','utf8').split('\n')) {
  const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]
}} catch{}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v,lo,hi) => Math.max(lo,Math.min(hi,v))
function cs(roi,p,d,w){if(roi==null)return null;return clip(Math.round((Math.min(70,roi>0?Math.log(1+roi/100)*25:Math.max(-70,roi/100*50))+(d!=null?Math.max(0,15*(1-d/100)):7.5)+(w!=null?Math.min(15,w/100*15):7.5))*10)/10,0,100)}
const DEBUG = process.argv.includes('--debug')
const log = (...a) => DEBUG && console.log('  [DBG]', ...a)

// ========================
// PLATFORM-SPECIFIC PARSERS
// ========================

function parseGeneric(item) {
  // Extended generic parser with more field names
  let id = ''
  for (const k of ['traderId','traderUid','uid','leaderId','encryptedUid','leadPortfolioId',
    'copyTradeId','leaderMark','userId','trader_id','address','accountId','account_id',
    'leaderAccountId','portfolioId','id']) {
    if (item[k] != null && String(item[k]).length > 1) { id = String(item[k]); break }
  }
  if (!id) return null

  let roi = null
  for (const k of ['yieldRate','roi','roiRate','totalRoi','pnlRate','returnRate','periodRoi',
    'copyTradeRoi','incomeRate','profitRate','roiValue','yield_rate','total_roi',
    'returnRatio','rate','earningRate']) {
    if (item[k] != null && item[k] !== '') {
      roi = parseFloat(item[k])
      // Detect if it's a decimal ratio (0.xxxx) vs percentage (xx.xx)
      if (k === 'incomeRate' || k === 'returnRatio' || k === 'rate' || k === 'earningRate') {
        if (Math.abs(roi) < 10) roi *= 100 // likely decimal
      } else if (Math.abs(roi) < 1 && roi !== 0 && k !== 'roi') {
        roi *= 100
      }
      break
    }
  }

  let pnl = null
  for (const k of ['totalProfit','profit','pnl','totalPnl','total_profit','income',
    'realizedPnl','realisedPnl','earnUsdt','totalEarnUsdt','profitAmount',
    'totalIncome','cumulativeProfit','cumulativeReturn']) {
    if (item[k] != null && item[k] !== '') { pnl = parseFloat(item[k]); break }
  }

  let wr = null
  for (const k of ['winRate','win_rate','winRatio','winPercent','winCount','profitOrderRate']) {
    if (item[k] != null && item[k] !== '') {
      wr = parseFloat(item[k])
      if (wr > 0 && wr <= 1) wr *= 100
      break
    }
  }

  let dd = null
  for (const k of ['maxDrawDown','maxDrawdown','mdd','max_drawdown','drawDown','drawdown',
    'maxRetraction','maxRetracement','maxLoss']) {
    if (item[k] != null && item[k] !== '') {
      dd = Math.abs(parseFloat(item[k]))
      if (dd > 0 && dd <= 1) dd *= 100
      break
    }
  }

  let trades = null
  for (const k of ['totalOrderNum','closedCount','tradeCount','orderCount','tradeTotalCount',
    'totalTradeNum','tradeNum','tradesCount','totalTrades']) {
    if (item[k] != null) { trades = parseInt(item[k]) || null; break }
  }

  let name = item.nickName || item.nickname || item.leaderName || item.name || item.displayName ||
    item.userName || item.user_name || item.traderName || ''

  let avatar = item.headUrl || item.avatarUrl || item.avatar || item.userPhoto || 
    item.portraitUrl || item.photoUrl || item.userAvatar || item.headImg || null

  let followers = null
  for (const k of ['followerCount','followers','copierCount','copyCount','followCount','followerNum']) {
    if (item[k] != null) { followers = parseInt(item[k]) || null; break }
  }

  // MUST have at least one metric to be a real trader (not a symbol/currency)
  const hasMetric = roi != null || pnl != null || wr != null || dd != null
  if (!hasMetric) return null

  return { id, name, avatar, roi, pnl, wr, dd, trades, followers }
}

// Deep search for trader arrays in nested JSON
function findTraderArrays(obj, depth=0) {
  const results = []
  if (depth > 8 || !obj) return results
  
  if (Array.isArray(obj)) {
    // Check if this array contains trader-like objects
    const traders = []
    for (const item of obj) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const parsed = parseGeneric(item)
        if (parsed) traders.push(parsed)
      }
    }
    if (traders.length >= 2) {
      results.push(traders)
    }
    // Also recurse into array elements
    for (const item of obj) {
      if (item && typeof item === 'object') {
        results.push(...findTraderArrays(item, depth + 1))
      }
    }
  } else if (typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      results.push(...findTraderArrays(v, depth + 1))
    }
  }
  
  return results
}

// ========================
// PLATFORM CONFIGS
// ========================

const PLATFORMS = {
  xt: {
    source: 'xt', market_type: 'futures',
    url: 'https://www.xt.com/en/copy-trading/futures',
    // XT uses elite-leader-list-v2 API - need to replay with pagination
    apiReplay: async (page, traders) => {
      const sortTypes = ['INCOME_RATE', 'FOLLOWER_COUNT']
      for (const st of sortTypes) {
        for (let size = 50; size <= 200; size += 50) {
          const result = await page.evaluate(async ({ size, st }) => {
            try {
              const r = await fetch(`/fapi/user/v1/public/copy-trade/elite-leader-list-v2?size=${size}&sotType=${st}`, { credentials: 'include' })
              return await r.json()
            } catch(e) { return { _err: e.message } }
          }, { size, st }).catch(() => null)
          
          if (!result || result._err) continue
          // XT returns [{sotType, hasMore, items:[...]}]
          if (Array.isArray(result.result)) {
            for (const group of result.result) {
              if (!group.items || !group.items.length) continue
              for (const it of group.items) {
                const t = parseGeneric(it)
                if (t) traders.set(t.id, t)
              }
            }
          }
        }
      }
      
      // Also try paginated list
      for (let pg = 1; pg <= 30; pg++) {
        const result = await page.evaluate(async ({ pg }) => {
          try {
            const r = await fetch(`/fapi/user/v1/public/copy-trade/leader-list?pageNo=${pg}&pageSize=50&sortType=INCOME_RATE`, { credentials: 'include' })
            const d = await r.json()
            return d.returnCode === 0 ? d : null
          } catch { return null }
        }, { pg }).catch(() => null)
        if (!result) break
        
        const items = result.result?.list || result.result?.items || 
          (Array.isArray(result.result) ? result.result.flatMap(g => g.items || []) : [])
        if (!items.length) break
        
        let newCount = 0
        for (const it of items) {
          const t = parseGeneric(it)
          if (t && !traders.has(t.id)) { traders.set(t.id, t); newCount++ }
        }
        if (newCount === 0) break
        process.stdout.write(`\r  XT p${pg}: ${traders.size}`)
        await sleep(300)
      }
    }
  },
  
  bitget_f: {
    source: 'bitget_futures', market_type: 'futures',
    url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0',
    apiReplay: async (page, traders) => {
      // Bitget uses traderViewV3 POST API with pagination
      // Discover the API from intercepted calls, then replay
      for (const sort of [0, 1, 2]) { // ROI, PnL, Followers
        for (let pg = 1; pg <= 20; pg++) {
          const result = await page.evaluate(async ({ pg, sort }) => {
            try {
              const r = await fetch('/v1/trigger/trace/public/traderViewV3', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageNo: pg, pageSize: 30, languageType: 7, sortType: sort, followType: 2 })
              })
              return await r.json()
            } catch(e) { return { _err: e.message } }
          }, { pg, sort }).catch(() => null)
          
          if (!result || result._err) break
          const arrays = findTraderArrays(result)
          let newCount = 0
          for (const arr of arrays) {
            for (const t of arr) {
              if (!traders.has(t.id)) { traders.set(t.id, t); newCount++ }
            }
          }
          if (newCount === 0 && pg > 1) break
          process.stdout.write(`\r  Bitget-F sort${sort} p${pg}: ${traders.size}`)
          await sleep(300)
        }
      }
    }
  },

  bitget_s: {
    source: 'bitget_spot', market_type: 'spot',
    url: 'https://www.bitget.com/copy-trading/spot',
    apiReplay: async (page, traders) => {
      for (const sort of [0, 1, 2]) {
        for (let pg = 1; pg <= 30; pg++) {
          const result = await page.evaluate(async ({ pg, sort }) => {
            try {
              const r = await fetch('/v1/trigger/trace/public/traderViewV3', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageNo: pg, pageSize: 30, languageType: 7, sortType: sort, followType: 3 })
              })
              return await r.json()
            } catch(e) { return { _err: e.message } }
          }, { pg, sort }).catch(() => null)
          
          if (!result || result._err) break
          const arrays = findTraderArrays(result)
          let newCount = 0
          for (const arr of arrays) {
            for (const t of arr) { if (!traders.has(t.id)) { traders.set(t.id, t); newCount++ } }
          }
          if (newCount === 0 && pg > 1) break
          process.stdout.write(`\r  Bitget-S sort${sort} p${pg}: ${traders.size}`)
          await sleep(300)
        }
      }
    }
  },

  coinex: {
    source: 'coinex', market_type: 'futures',
    url: 'https://www.coinex.com/copy-trading',
  },
  
  kucoin: {
    source: 'kucoin', market_type: 'futures', 
    url: 'https://www.kucoin.com/copy-trading/leaderboard',
  },

  bybit: {
    source: 'bybit', market_type: 'futures',
    url: 'https://www.bybit.com/copyTrade/',
  },

  mexc: {
    source: 'mexc', market_type: 'futures',
    url: 'https://www.mexc.com/copy-trading',
  },

  bingx: {
    source: 'bingx', market_type: 'futures',
    url: 'https://bingx.com/en/copy-trading/',
  },

  phemex: {
    source: 'phemex', market_type: 'futures',
    url: 'https://phemex.com/copy-trading',
  },

  weex: {
    source: 'weex', market_type: 'futures',
    url: 'https://www.weex.com/zh-CN/copy-trading',
  },

  lbank: {
    source: 'lbank', market_type: 'futures',
    url: 'https://www.lbank.com/copy-trading',
  },
}

const PORT = 9338

async function launchChrome() {
  try { execSync('pkill -f "remote-debugging-port=9338"', { stdio: 'ignore' }) } catch {}
  await sleep(2000)
  spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-fix-profile',
    '--no-first-run','--disable-extensions','--disable-sync','--disable-gpu',
    '--window-size=1200,900','--window-position=9999,9999',
    '--proxy-server=http://127.0.0.1:7890','about:blank',
  ], { stdio: 'ignore', detached: true }).unref()
  for (let i = 0; i < 25; i++) {
    await sleep(500)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch {}
  }
  throw new Error('Chrome timeout')
}

async function save(source, tradersMap, market_type) {
  const traders = [...tradersMap.values()]
  if (!traders.length) return 0
  const now = new Date().toISOString()
  let saved = 0
  for (let i=0;i<traders.length;i+=50)
    try{await sb.from('trader_sources').upsert(traders.slice(i,i+50).map(t=>({
      source, source_trader_id:t.id, handle:t.name||t.id,
      avatar_url:t.avatar||null, market_type, is_active:true
    })),{onConflict:'source,source_trader_id'})}catch(e){log('src err:',e.message)}
  for (let i=0;i<traders.length;i+=30){
    const{error}=await sb.from('trader_snapshots').upsert(traders.slice(i,i+30).map((t,j)=>({
      source, source_trader_id:t.id, season_id:'30D',
      rank:i+j+1, roi:t.roi, pnl:t.pnl, win_rate:t.wr,
      max_drawdown:t.dd, trades_count:t.trades,
      arena_score:cs(t.roi,t.pnl,t.dd,t.wr), captured_at:now
    })),{onConflict:'source,source_trader_id,season_id'})
    if(!error)saved+=Math.min(30,traders.length-i)
    else log('snap err:', error.message)
  }
  return saved
}

async function runPlatform(name) {
  const cfg = PLATFORMS[name]
  if (!cfg) return
  
  console.log(`\n📊 ${name.toUpperCase()} (${cfg.source})`)
  const traders = new Map()
  
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0] || await browser.newContext()
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm,ico}', r => r.abort())
  
  // Capture ALL JSON responses and extract traders
  const allResponses = [] // for debugging
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const url = res.url()
      if (url.includes('analytics')||url.includes('google')||url.includes('cdn-cgi')||
          url.includes('sentry')||url.includes('pixel')||url.includes('tingyun')||
          url.includes('zendesk')||url.includes('globalmathai')) return
      
      const d = await res.json()
      const arrays = findTraderArrays(d)
      let totalNew = 0
      for (const arr of arrays) {
        for (const t of arr) {
          if (!traders.has(t.id)) { traders.set(t.id, t); totalNew++ }
        }
      }
      if (totalNew > 0) {
        log(`Response ${url.substring(0,80)} → +${totalNew} (total: ${traders.size})`)
      }
      if (arrays.length > 0 || DEBUG) {
        allResponses.push({ url: url.substring(0,120), arrays: arrays.length, traders: totalNew })
      }
    } catch {}
  })
  
  // Load page
  await page.goto(cfg.url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})
  
  // CF wait
  let cfOk = false
  for (let i = 0; i < 30; i++) {
    const t = await page.title().catch(() => '')
    if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
    await sleep(1500)
  }
  if (!cfOk) { console.log('  ❌ CF failed'); await ctx.close(); return }
  console.log('  CF ✅')
  
  // Wait for data to load
  await sleep(10000)
  
  // Scroll to trigger lazy loading
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
    await sleep(2000)
  }
  
  console.log(`  初始拦截: ${traders.size} traders`)
  
  // Run platform-specific API replay if available
  if (cfg.apiReplay) {
    console.log('  API 翻页...')
    await cfg.apiReplay(page, traders)
    console.log()
  }
  
  // Try clicking pagination
  for (let attempt = 0; attempt < 15; attempt++) {
    const before = traders.size
    const clicked = await page.evaluate(() => {
      // Next page buttons
      const selectors = [
        'button[class*="next"]', '[class*="next-page"]', '[aria-label="Next"]',
        '[class*="ant-pagination-next"] button', 'li.next a',
      ]
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel)
          if (el && !el.disabled && el.offsetParent) { el.click(); return sel }
        } catch {}
      }
      // By text
      for (const b of document.querySelectorAll('button, a')) {
        const t = b.textContent?.trim()
        if ((t === '>' || t === '›' || t === '下一页' || t === 'Next') && b.offsetParent) {
          b.click(); return 'text:' + t
        }
      }
      // Number pages
      const pages = document.querySelectorAll('[class*="pagination"] li, [class*="pager"] span')
      const cur = [...pages].find(el => el.classList.toString().includes('active') || el.getAttribute('aria-current'))
      if (cur?.nextElementSibling) {
        const btn = cur.nextElementSibling.querySelector('a,button') || cur.nextElementSibling
        btn.click(); return 'page-num'
      }
      // Load more
      for (const b of document.querySelectorAll('button, div[role="button"]')) {
        if (/more|load|加载|查看更多/i.test(b.textContent?.trim())) { b.click(); return 'load-more' }
      }
      return null
    }).catch(() => null)
    
    if (clicked) {
      await sleep(3000)
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
        await sleep(1000)
      }
      if (traders.size > before) {
        process.stdout.write(`\r  翻页 ${attempt+1}: ${traders.size}`)
      } else if (traders.size === before) {
        // 2 consecutive empty pages = stop
        const next = await page.evaluate(() => {
          const btns = document.querySelectorAll('[class*="next"]')
          return [...btns].some(b => b.disabled || b.classList.toString().includes('disabled'))
        }).catch(() => true)
        if (next) break
      }
    } else {
      break
    }
  }
  
  // Debug: show what we captured
  if (DEBUG || traders.size === 0) {
    console.log(`\n  Debug - ${allResponses.length} JSON responses:`)
    for (const r of allResponses.slice(0, 10)) {
      console.log(`    ${r.url} → arrays:${r.arrays} traders:${r.traders}`)
    }
  }
  
  // Check data quality
  const withRoi = [...traders.values()].filter(t => t.roi != null).length
  const withPnl = [...traders.values()].filter(t => t.pnl != null).length
  console.log(`\n  数据: ${traders.size} traders (ROI: ${withRoi}, PnL: ${withPnl})`)
  
  // Save
  if (traders.size > 0) {
    const saved = await save(cfg.source, traders, cfg.market_type)
    console.log(`  ✅ ${saved} saved`)
  } else {
    console.log('  ❌ 0')
  }
  
  await ctx.close()
}

async function main() {
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }).catch(()=>{})
  await sleep(1000)
  
  await launchChrome()
  
  const target = process.argv[2]
  const platforms = target && !target.startsWith('-') ? [target] : 
    ['xt','bitget_f','bitget_s','coinex','kucoin','bybit','mexc','bingx','phemex','weex','lbank']
  
  for (const name of platforms) {
    if (!PLATFORMS[name]) { console.log(`❌ unknown: ${name}`); continue }
    try {
      await runPlatform(name)
    } catch(e) {
      console.log(`  ❌ ${name}: ${e.message?.substring(0,60)}`)
    }
  }
  
  try { execSync('pkill -f "remote-debugging-port=9338"', { stdio: 'ignore' }) } catch {}
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }).catch(()=>{})
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e.message); process.exit(1) })
