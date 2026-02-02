#!/usr/bin/env node
/**
 * Direct API pagination — uses browser only for CF bypass, then fetches
 * API pages directly using cookies extracted from the browser session.
 * 
 * Much faster than UI pagination or in-browser fetch replay.
 * 
 * Usage: node browser-direct-paginate.mjs <platform|all> [--debug] [--dry-run]
 */
import { readFileSync } from 'fs'
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
const DRY_RUN = process.argv.includes('--dry-run')
const log = (...a) => DEBUG && console.log('[DBG]', ...a)
const PORT = 9335

function extractTraders(obj, depth=0) {
  const results = []
  if (depth > 5 || !obj) return results
  if (Array.isArray(obj) && obj.length >= 2) {
    for (const it of obj) {
      if (!it || typeof it !== 'object') continue
      const keys = Object.keys(it)
      const hasId = keys.some(k => /trader|uid|leader|address|portfolio|userId|copyTrade|leaderMark/i.test(k)) || it.id
      const hasMetric = keys.some(k => /roi|pnl|yield|profit|winRate|return|income/i.test(k))
      const hasName = keys.some(k => /nick|name|displayName/i.test(k))
      if (!hasId || (!hasMetric && !hasName)) continue
      let id = ''
      for (const k of ['traderId','traderUid','uid','leaderId','encryptedUid','leadPortfolioId','copyTradeId','leaderMark','userId','trader_id','address','id']) {
        if (it[k] != null && String(it[k]).length > 1) { id = String(it[k]); break }
      }
      if (!id) continue
      let roi = null
      for (const k of ['yieldRate','roi','roiRate','totalRoi','pnlRate','returnRate','periodRoi','copyTradeRoi','incomeRate']) {
        if (it[k] != null) { roi = parseFloat(it[k]); if (Math.abs(roi) < 20 && roi !== 0 && k !== 'roi') roi *= 100; break }
      }
      let pnl = null; for (const k of ['totalProfit','profit','pnl','totalPnl','income']) { if (it[k] != null) { pnl = parseFloat(it[k]); break } }
      let wr = null; for (const k of ['winRate','win_rate','winRatio']) { if (it[k] != null) { wr = parseFloat(it[k]); if (wr > 0 && wr <= 1) wr *= 100; break } }
      let dd = null; for (const k of ['maxDrawDown','maxDrawdown','mdd','drawDown']) { if (it[k] != null) { dd = Math.abs(parseFloat(it[k])); if (dd > 0 && dd < 1) dd *= 100; break } }
      let followers = null; for (const k of ['followerCount','followers','copierCount','copyCount']) { if (it[k] != null) { followers = parseInt(it[k]); break } }
      results.push({ id, name: it.nickName||it.nickname||it.leaderName||it.name||it.displayName||'',
        avatar: it.headUrl||it.avatarUrl||it.avatar||it.userPhoto||it.portraitUrl||null,
        roi, pnl, wr, dd, trades: parseInt(it.totalOrderNum||it.closedCount||it.tradeCount||0)||null,
        followers })
    }
  }
  if (typeof obj === 'object' && !Array.isArray(obj)) for (const v of Object.values(obj)) results.push(...extractTraders(v, depth+1))
  return results
}

// Platform API configurations — discovered from previous runs
const PLATFORMS = {
  bitget_f: {
    source: 'bitget_futures', market_type: 'futures',
    landingUrl: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0',
    api: {
      url: 'https://www.bitget.com/v1/trigger/trace/public/traderViewV3',
      method: 'POST',
      bodies: [
        // ROI sort
        { simulation: 0, pageNo: 1, pageSize: 30, sortRule: 2, sortFlag: 0, dataCycle: 30, model: 1, fullStatistic: false },
        // PnL sort
        { simulation: 0, pageNo: 1, pageSize: 30, sortRule: 2, sortFlag: 1, dataCycle: 30, model: 1, fullStatistic: false },
        // Followers sort
        { simulation: 0, pageNo: 1, pageSize: 30, sortRule: 2, sortFlag: 2, dataCycle: 30, model: 1, fullStatistic: false },
      ],
      pageParam: 'pageNo',
      pageSize: 30,
      maxPages: 10,
    },
  },
  bitget_s: {
    source: 'bitget_spot', market_type: 'spot',
    landingUrl: 'https://www.bitget.com/copy-trading/spot',
    api: null, // Different endpoint - discover dynamically
  },
  bybit: {
    source: 'bybit', market_type: 'futures',
    landingUrl: 'https://www.bybit.com/copyTrade/',
    api: null, // Will discover dynamically
  },
  bingx: {
    source: 'bingx', market_type: 'futures',
    landingUrl: 'https://bingx.com/en/copy-trading/',
    api: null,
  },
  phemex: {
    source: 'phemex', market_type: 'futures',
    landingUrl: 'https://phemex.com/copy-trading',
    api: null,
  },
  weex: {
    source: 'weex', market_type: 'futures',
    landingUrl: 'https://www.weex.com/zh-CN/copy-trading',
    api: null,
  },
  lbank: {
    source: 'lbank', market_type: 'futures',
    landingUrl: 'https://www.lbank.com/copy-trading',
    api: null,
  },
}

async function launchChrome() {
  try { execSync('pkill -f "remote-debugging-port=9335"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-replay-profile',
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
  throw new Error('Chrome did not start')
}

async function save(source, tradersMap, market_type) {
  if (DRY_RUN) { console.log(`  [DRY RUN] Would save ${tradersMap.size} traders`); return tradersMap.size }
  const traders = [...tradersMap.values()]
  if (!traders.length) return 0
  const now = new Date().toISOString()
  let saved = 0
  for (let i=0;i<traders.length;i+=50) {
    try {
      await sb.from('trader_sources').upsert(
        traders.slice(i,i+50).map(t=>({
          source, source_trader_id:t.id, handle:t.name||t.id,
          avatar_url:t.avatar, market_type, is_active:true,
          ...(t.followers ? {follower_count: t.followers} : {})
        })),
        {onConflict:'source,source_trader_id'}
      )
    } catch(e) { log('src err:', e.message) }
  }
  for (let i=0;i<traders.length;i+=30) {
    const{error}=await sb.from('trader_snapshots').upsert(
      traders.slice(i,i+30).map((t,j)=>({
        source, source_trader_id:t.id, season_id:'30D',
        rank:i+j+1, roi:t.roi, pnl:t.pnl, win_rate:t.wr,
        max_drawdown:t.dd, trades_count:t.trades,
        arena_score:cs(t.roi,t.pnl,t.dd,t.wr), captured_at:now
      })),
      {onConflict:'source,source_trader_id,season_id'}
    )
    if(!error) saved+=Math.min(30,traders.length-i)
    else log('snap err:', error.message)
  }
  return saved
}

async function runPlatform(name) {
  const cfg = PLATFORMS[name]
  if (!cfg) { console.log(`❌ Unknown: ${name}`); return null }
  
  console.log(`\n${'='.repeat(50)}`)
  console.log(`📊 ${name.toUpperCase()} (${cfg.source})`)
  console.log(`${'='.repeat(50)}`)
  
  await launchChrome()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const traders = new Map()
  
  // Track discovered APIs
  const discoveredApis = []
  const traderApis = []
  
  try {
    const context = browser.contexts()[0] || await browser.newContext()
    const page = await context.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm,ico}', r => r.abort())
    
    // Capture ALL requests + responses for API discovery
    const requestMap = new Map()
    page.on('request', req => {
      try {
        if (req.resourceType() !== 'fetch' && req.resourceType() !== 'xhr') return
        const url = req.url()
        if (url.includes('analytics')||url.includes('google')||url.includes('pixel')||url.includes('sentry')||url.includes('cdn-cgi')) return
        requestMap.set(url + req.method(), {
          url, method: req.method(), body: req.postData(),
          headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => 
            !['accept-encoding','connection','host','sec-ch','sec-fetch'].some(p => k.startsWith(p))
          ))
        })
      } catch {}
    })
    
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const url = res.url()
        if (url.includes('analytics')||url.includes('google')||url.includes('cdn-cgi')) return
        const d = await res.json()
        const found = extractTraders(d)
        if (found.length > 0) {
          for (const t of found) traders.set(t.id, t)
          const reqInfo = requestMap.get(url + res.request().method())
          if (reqInfo) traderApis.push({ ...reqInfo, traderCount: found.length, responseData: d })
          log(`Intercepted: ${url.substring(0,80)} → ${found.length} traders (total: ${traders.size})`)
        }
      } catch {}
    })
    
    // Load page and pass CF
    console.log(`  Loading ${cfg.landingUrl.substring(0,60)}...`)
    await page.goto(cfg.landingUrl, { timeout: 60000, waitUntil: 'load' }).catch(()=>{})
    
    let cfOk = false
    await sleep(5000) // Give CF challenge time to render
    for (let i = 0; i < 60; i++) {
      const t = await page.title().catch(() => '')
      log(`Title check ${i}: "${t}"`)
      if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && !t.includes('Just') && t.length > 3) { cfOk = true; break }
      await sleep(2000)
    }
    if (!cfOk) { console.log('  ❌ CF/page load failed'); return null }
    console.log('  ✅ Page loaded')
    
    // Wait for API data + scroll to trigger lazy loads
    await sleep(8000)
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
      await sleep(1500)
    }
    await sleep(3000)
    
    console.log(`  初始加载: ${traders.size} traders from ${traderApis.length} API call(s)`)
    
    // Extract cookies for direct fetch
    let cookieStr = '', ua = ''
    try {
      const cookies = await context.cookies()
      cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
      ua = await page.evaluate(() => navigator.userAgent)
    } catch(e) { log('Cookie extraction failed:', e.message) }
    
    // Now do API pagination
    // If we have a known API config, use it. Otherwise use discovered APIs.
    const apiConfigs = cfg.api ? cfg.api.bodies.map(b => ({
      url: cfg.api.url, method: cfg.api.method, body: b,
      pageParam: cfg.api.pageParam, pageSize: cfg.api.pageSize, maxPages: cfg.api.maxPages
    })) : []
    
    // Also add discovered APIs
    for (const api of traderApis) {
      if (api.body) {
        try {
          const bodyObj = JSON.parse(api.body)
          const pageParam = ['pageNo','pageNum','pageIndex','page','current','offset'].find(k => bodyObj[k] != null)
          const sizeParam = ['pageSize','limit','size','count'].find(k => bodyObj[k] != null)
          if (pageParam) {
            apiConfigs.push({
              url: api.url, method: api.method, body: bodyObj,
              pageParam, pageSize: sizeParam ? bodyObj[sizeParam] : 20,
              maxPages: 15, headers: api.headers
            })
          }
        } catch {}
      } else {
        // GET with URL params
        try {
          const u = new URL(api.url)
          const pageParam = ['pageNo','pageNum','page','offset','cursor'].find(k => u.searchParams.has(k))
          if (pageParam) {
            apiConfigs.push({
              url: api.url, method: 'GET', body: null,
              pageParam, pageSize: parseInt(u.searchParams.get('pageSize')||u.searchParams.get('limit')||'20'),
              maxPages: 15, headers: api.headers
            })
          }
        } catch {}
      }
    }
    
    log(`API configs to paginate: ${apiConfigs.length}`)
    
    // Paginate each API
    const seen = new Set()
    for (const apiCfg of apiConfigs) {
      const apiKey = apiCfg.url + JSON.stringify(apiCfg.body||{})
      if (seen.has(apiKey)) continue
      seen.add(apiKey)
      
      console.log(`  API: ${apiCfg.url.substring(apiCfg.url.lastIndexOf('/')+1).substring(0,40)} (${apiCfg.pageParam})`)
      
      let emptyRuns = 0
      for (let p = 2; p <= (apiCfg.maxPages || 15); p++) {
        const before = traders.size
        let result
        
        try {
          if (apiCfg.method === 'POST' && apiCfg.body) {
            const newBody = { ...apiCfg.body }
            if (apiCfg.pageParam === 'offset') {
              newBody[apiCfg.pageParam] = (p - 1) * apiCfg.pageSize
            } else {
              newBody[apiCfg.pageParam] = p
            }
            
            // Use page.evaluate for cookie-authenticated fetch
            result = await page.evaluate(async ({ url, body }) => {
              try {
                const r = await fetch(url, {
                  method: 'POST', credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body)
                })
                const text = await r.text()
                try { return JSON.parse(text) } catch { return { _err: 'parse', _text: text.substring(0, 200) } }
              } catch(e) { return { _err: e.message } }
            }, { url: apiCfg.url, body: newBody })
          } else {
            const u = new URL(apiCfg.url)
            u.searchParams.set(apiCfg.pageParam, apiCfg.pageParam === 'offset' ? (p-1)*apiCfg.pageSize : p)
            
            result = await page.evaluate(async (url) => {
              try {
                const r = await fetch(url, { credentials: 'include' })
                const text = await r.text()
                try { return JSON.parse(text) } catch { return { _err: 'parse', _text: text.substring(0, 200) } }
              } catch(e) { return { _err: e.message } }
            }, u.toString())
          }
        } catch(e) {
          log(`Page ${p} evaluate error:`, e.message)
          emptyRuns++
          if (emptyRuns >= 2) break
          continue
        }
        
        if (result?._err) {
          log(`Page ${p} error:`, result._err, result._text?.substring(0,100))
          emptyRuns++
          if (emptyRuns >= 2) break
          continue
        }
        
        const found = extractTraders(result)
        for (const t of found) traders.set(t.id, t)
        const newCount = traders.size - before
        
        if (found.length === 0 || newCount === 0) {
          emptyRuns++
          if (emptyRuns >= 2) { log(`2 empty pages, stopping`); break }
        } else {
          emptyRuns = 0
          process.stdout.write(`\r    p${p}: +${newCount} → ${traders.size} total`)
        }
        
        await sleep(400 + Math.random() * 400)
      }
      console.log() // newline after progress
    }
    
    // If no APIs discovered, try scroll-based loading
    if (apiConfigs.length === 0) {
      console.log('  No paginated APIs found. Trying scroll + load-more...')
      
      for (let scroll = 0; scroll < 30; scroll++) {
        const before = traders.size
        
        // Scroll
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
        await sleep(2000)
        
        // Click load more
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, a, div[role="button"]')]
          const btn = btns.find(b => /more|load|加载|展开|查看更多|see more|view more/i.test(b.textContent?.trim()))
          if (btn) { btn.click(); return true }
          // Try next page
          const nextBtns = btns.filter(b => /next|下一页|›|»/i.test(b.textContent?.trim()))
          for (const nb of nextBtns) { if (!nb.disabled) { nb.click(); return true } }
          return false
        }).catch(() => false)
        
        await sleep(2000)
        
        if (traders.size === before) {
          if (scroll > 3) break // No new data after initial loads
        } else {
          process.stdout.write(`\r    scroll ${scroll}: ${traders.size} traders`)
        }
      }
      console.log()
    }
    
    // Save
    const total = traders.size
    if (total > 0) {
      const saved = await save(cfg.source, traders, cfg.market_type)
      console.log(`  ✅ Saved ${saved}/${total} traders`)
    } else {
      console.log('  ❌ No traders found')
    }
    
    await page.close().catch(()=>{})
    return { source: cfg.source, count: total }
    
  } finally {
    try { await browser.close() } catch {}
    try { execSync('pkill -f "remote-debugging-port=9335"', { stdio: 'ignore' }) } catch {}
    await sleep(1000)
  }
}

async function main() {
  // Enable proxy
  await fetch('http://127.0.0.1:9090/configs', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'global' })
  }).catch(()=>{ console.log('⚠️ Proxy not available') })
  await sleep(500)
  
  const arg = process.argv[2]
  if (!arg) { console.log('Usage: node browser-direct-paginate.mjs <platform|all> [--debug] [--dry-run]'); process.exit(1) }
  
  const platforms = arg === 'all' 
    ? ['bitget_f','bitget_s','bybit','bingx','phemex','weex','lbank']
    : [arg]
  
  const results = {}
  
  for (const p of platforms) {
    try {
      const r = await runPlatform(p)
      results[p] = r
    } catch(e) {
      console.log(`  ❌ ${p}: ${e.message}`)
      results[p] = { source: PLATFORMS[p]?.source || p, count: 0, error: e.message }
    }
    // Kill Chrome between platforms
    try { execSync('pkill -f "remote-debugging-port"', { stdio: 'ignore' }) } catch {}
    await sleep(2000)
  }
  
  // Summary
  console.log('\n' + '='.repeat(50))
  console.log('📋 Summary:')
  for (const [p, r] of Object.entries(results)) {
    console.log(`  ${p}: ${r?.count || 0} traders ${r?.error ? '❌ ' + r.error : ''}`)
  }
  
  // Restore proxy
  await fetch('http://127.0.0.1:9090/configs', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'direct' })
  }).catch(()=>{})
}

main().then(() => process.exit(0)).catch(e => { console.log('❌', e.message); process.exit(1) })
