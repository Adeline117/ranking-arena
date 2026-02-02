#!/usr/bin/env node
/**
 * 浏览器内 API 翻页 — 先加载页面过 CF，然后在浏览器 context 内直接 fetch 所有页
 * 比 UI 翻页快 10x：不用等 DOM render，直接拿 JSON
 * 
 * 用法: node browser-api-replay.mjs <platform> [--debug]
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
const log = (...a) => DEBUG && console.log('[DBG]', ...a)

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
      results.push({ id, name: it.nickName||it.nickname||it.leaderName||it.name||it.displayName||'',
        avatar: it.headUrl||it.avatarUrl||it.avatar||it.userPhoto||it.portraitUrl||null,
        roi, pnl, wr, dd, trades: parseInt(it.totalOrderNum||it.closedCount||it.tradeCount||0)||null })
    }
  }
  if (typeof obj === 'object' && !Array.isArray(obj)) for (const v of Object.values(obj)) results.push(...extractTraders(v, depth+1))
  return results
}

// Platform-specific API replay configs
// Each has: landingUrl, apiConfigs (list of {method, url, bodyTemplate, pageParam, sizeParam, maxPages})
const PLATFORMS = {
  bitget_f: {
    source: 'bitget_futures', market_type: 'futures',
    landingUrl: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0',
    apiConfigs: [
      // We'll discover the API dynamically, but provide known patterns
      { discover: true },
    ],
    sortUrls: [
      'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', // ROI
      'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=1', // PnL
      'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=2', // Followers
    ],
  },
  bitget_s: {
    source: 'bitget_spot', market_type: 'spot',
    landingUrl: 'https://www.bitget.com/copy-trading/spot',
    apiConfigs: [{ discover: true }],
    sortUrls: [
      'https://www.bitget.com/copy-trading/spot',
      'https://www.bitget.com/copy-trading/spot?sort=1',
    ],
  },
  bybit: {
    source: 'bybit', market_type: 'futures',
    landingUrl: 'https://www.bybit.com/copyTrade/',
    apiConfigs: [{ discover: true }],
    sortUrls: [
      'https://www.bybit.com/copyTrade/',
    ],
  },
  bingx: {
    source: 'bingx', market_type: 'futures',
    landingUrl: 'https://bingx.com/en/copy-trading/',
    apiConfigs: [{ discover: true }],
  },
  phemex: {
    source: 'phemex', market_type: 'futures',
    landingUrl: 'https://phemex.com/copy-trading',
    apiConfigs: [{ discover: true }],
  },
  weex: {
    source: 'weex', market_type: 'futures',
    landingUrl: 'https://www.weex.com/zh-CN/copy-trading',
    apiConfigs: [{ discover: true }],
  },
  lbank: {
    source: 'lbank', market_type: 'futures',
    landingUrl: 'https://www.lbank.com/copy-trading',
    apiConfigs: [{ discover: true }],
  },
}

const name = process.argv[2]
if (!PLATFORMS[name]) { console.log('❌ unknown: ' + name + '. Options: ' + Object.keys(PLATFORMS).join(',')); process.exit(1) }
const cfg = PLATFORMS[name]
const PORT = 9335

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
  throw new Error('Chrome timeout')
}

async function save(source, tradersMap, market_type) {
  const traders = [...tradersMap.values()]
  if (!traders.length) return 0
  const now = new Date().toISOString()
  let saved = 0
  for (let i=0;i<traders.length;i+=50)
    try{await sb.from('trader_sources').upsert(traders.slice(i,i+50).map(t=>({source,source_trader_id:t.id,handle:t.name||t.id,avatar_url:t.avatar,market_type,is_active:true})),{onConflict:'source,source_trader_id'})}catch(e){log('src err:',e.message)}
  for (let i=0;i<traders.length;i+=30){
    const{error}=await sb.from('trader_snapshots').upsert(traders.slice(i,i+30).map((t,j)=>({source,source_trader_id:t.id,season_id:'30D',rank:i+j+1,roi:t.roi,pnl:t.pnl,win_rate:t.wr,max_drawdown:t.dd,trades_count:t.trades,arena_score:cs(t.roi,t.pnl,t.dd,t.wr),captured_at:now})),{onConflict:'source,source_trader_id,season_id'})
    if(!error)saved+=Math.min(30,traders.length-i)}
  return saved
}

async function main() {
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }).catch(()=>{})
  await sleep(1000)
  
  await launchChrome()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const traders = new Map()

  try {
    console.log(`📊 ${name.toUpperCase()} — API replay 模式`)
    const context = browser.contexts()[0] || await browser.newContext()
    const page = await context.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm,ico}', r => r.abort())
    
    // Capture API requests with trader data
    const discoveredApis = []
    page.on('request', req => {
      try {
        if (req.resourceType() !== 'fetch' && req.resourceType() !== 'xhr') return
        const url = req.url()
        if (url.includes('analytics')||url.includes('google')||url.includes('pixel')||url.includes('sentry')||url.includes('cdn-cgi')) return
        discoveredApis.push({
          url, method: req.method(), body: req.postData(),
          headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => 
            !['accept-encoding','connection','host','user-agent','sec-'].some(p => k.startsWith(p))
          ))
        })
      } catch {}
    })
    
    const responses = new Map() // url -> response data
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const url = res.url()
        if (url.includes('analytics')||url.includes('google')||url.includes('cdn-cgi')) return
        const d = await res.json()
        const found = extractTraders(d)
        if (found.length > 0) {
          responses.set(url, { data: d, traderCount: found.length })
          for (const t of found) traders.set(t.id, t)
          log(`First load: ${url.substring(0,80)} → ${found.length} traders`)
        }
      } catch {}
    })

    // Load landing page
    await page.goto(cfg.landingUrl, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})
    
    // CF wait
    let cfOk = false
    for (let i = 0; i < 30; i++) {
      const t = await page.title().catch(() => '')
      if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
      await sleep(1500)
    }
    if (!cfOk) { console.log('❌ CF failed'); return }
    console.log('  CF ✅')

    // Wait for initial data
    await sleep(10000)
    // Scroll once to trigger lazy loads
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
      await sleep(2000)
    }

    console.log(`  初始: ${traders.size} traders from ${responses.size} API calls`)
    
    // Analyze captured APIs that returned trader data
    const traderApis = discoveredApis.filter(api => {
      const urlKey = api.url.split('?')[0]
      return [...responses.keys()].some(rUrl => rUrl.split('?')[0] === urlKey)
    })
    
    log(`Trader APIs found: ${traderApis.length}`)
    for (const api of traderApis) log(`  ${api.method} ${api.url.substring(0,100)} body=${api.body?.substring(0,100)}`)

    // For each trader API, replay with pagination
    for (const api of traderApis) {
      let pageParam = null, sizeParam = null, currentPage = null, pageSize = null
      let isPost = api.method === 'POST'
      let bodyObj = null
      
      if (isPost && api.body) {
        try {
          bodyObj = JSON.parse(api.body)
          // Find page param
          for (const k of ['pageNo','pageNum','pageIndex','page','current','offset']) {
            if (bodyObj[k] != null) { pageParam = k; currentPage = parseInt(bodyObj[k]); break }
          }
          for (const k of ['pageSize','limit','size','count']) {
            if (bodyObj[k] != null) { sizeParam = k; pageSize = parseInt(bodyObj[k]); break }
          }
        } catch {}
      } else {
        // Check URL params
        const u = new URL(api.url)
        for (const k of ['pageNo','pageNum','pageIndex','page','current','offset']) {
          if (u.searchParams.has(k)) { pageParam = k; currentPage = parseInt(u.searchParams.get(k)); break }
        }
        for (const k of ['pageSize','limit','size','count']) {
          if (u.searchParams.has(k)) { sizeParam = k; pageSize = parseInt(u.searchParams.get(k)); break }
        }
      }
      
      if (!pageParam) {
        log(`No pagination param found for ${api.url.substring(0,80)}`)
        // Try adding pagination params
        if (isPost && bodyObj) {
          pageParam = 'pageNo'; sizeParam = 'pageSize'
          currentPage = 1; pageSize = bodyObj.pageSize || 30
          bodyObj[pageParam] = currentPage
          if (!bodyObj[sizeParam]) bodyObj[sizeParam] = pageSize
        } else {
          continue
        }
      }
      
      console.log(`  API: ${api.url.substring(0,60)}... (${pageParam}=${currentPage}, ${sizeParam}=${pageSize})`)
      
      // Replay pages
      const maxPage = pageParam === 'offset' ? 50 : 30
      let emptyPages = 0
      
      for (let p = (currentPage || 1) + 1; p <= maxPage; p++) {
        const before = traders.size
        
        let result
        if (isPost) {
          const newBody = { ...bodyObj }
          if (pageParam === 'offset') {
            newBody[pageParam] = (p - 1) * (pageSize || 20)
          } else {
            newBody[pageParam] = p
          }
          
          result = await page.evaluate(async ({ url, body, headers }) => {
            try {
              const r = await fetch(url, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(body)
              })
              return await r.json()
            } catch(e) { return { _err: e.message } }
          }, { url: api.url, body: newBody, headers: api.headers || {} }).catch(() => null)
        } else {
          const u = new URL(api.url)
          if (pageParam === 'offset') {
            u.searchParams.set(pageParam, (p - 1) * (pageSize || 20))
          } else {
            u.searchParams.set(pageParam, p)
          }
          result = await page.evaluate(async (url) => {
            try {
              const r = await fetch(url, { credentials: 'include' })
              return await r.json()
            } catch(e) { return { _err: e.message } }
          }, u.toString()).catch(() => null)
        }
        
        if (result && !result._err) {
          const found = extractTraders(result)
          for (const t of found) traders.set(t.id, t)
          const newCount = traders.size - before
          
          if (found.length === 0 || newCount === 0) {
            emptyPages++
            if (emptyPages >= 2) { log(`2 empty pages, stopping`); break }
          } else {
            emptyPages = 0
            process.stdout.write(`\r  p${p}: +${newCount} → ${traders.size}`)
          }
        } else {
          log(`API error on page ${p}:`, result?._err)
          emptyPages++
          if (emptyPages >= 2) break
        }
        
        await sleep(300 + Math.random() * 500) // Random delay to avoid rate limits
      }
      console.log()
    }
    
    // Also try different sort orders if configured
    if (cfg.sortUrls && cfg.sortUrls.length > 1) {
      for (let si = 1; si < cfg.sortUrls.length; si++) {
        const sortUrl = cfg.sortUrls[si]
        console.log(`  排序 ${si+1}: ${sortUrl.substring(0,60)}...`)
        
        const newApis = []
        const sortHandler = req => {
          try {
            if (req.resourceType() !== 'fetch' && req.resourceType() !== 'xhr') return
            const url = req.url()
            if (url.includes('analytics')||url.includes('google')||url.includes('cdn-cgi')) return
            newApis.push({ url, method: req.method(), body: req.postData() })
          } catch {}
        }
        page.on('request', sortHandler)
        
        await page.goto(sortUrl, { timeout: 30000, waitUntil: 'load' }).catch(()=>{})
        await sleep(8000)
        
        // Check responses
        const sortResponseHandler = async res => {
          try {
            const ct = res.headers()['content-type'] || ''
            if (!ct.includes('json')) return
            const d = await res.json()
            const found = extractTraders(d)
            for (const t of found) traders.set(t.id, t)
          } catch {}
        }
        page.on('response', sortResponseHandler)
        
        // Scroll
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
          await sleep(2000)
        }
        
        // Replay pagination for newly discovered APIs
        for (const api of newApis) {
          if (!api.body) continue
          try {
            const bodyObj = JSON.parse(api.body)
            const pageParam = ['pageNo','pageNum','page'].find(k => bodyObj[k] != null)
            if (!pageParam) continue
            
            for (let p = 2; p <= 20; p++) {
              const newBody = { ...bodyObj, [pageParam]: p }
              const result = await page.evaluate(async ({ url, body }) => {
                try {
                  const r = await fetch(url, { method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                  return await r.json()
                } catch { return null }
              }, { url: api.url, body: newBody }).catch(() => null)
              
              if (!result) break
              const before = traders.size
              const found = extractTraders(result)
              for (const t of found) traders.set(t.id, t)
              if (found.length === 0 || traders.size === before) break
              process.stdout.write(`\r  sort${si+1} p${p}: ${traders.size}`)
              await sleep(400)
            }
            console.log()
          } catch {}
        }
        
        page.removeListener('request', sortHandler)
        page.removeListener('response', sortResponseHandler)
      }
    }
    
    // Save all
    if (traders.size > 0) {
      const saved = await save(cfg.source, traders, cfg.market_type)
      console.log(`✅ ${saved} 保存 (${traders.size} unique)`)
    } else {
      console.log('❌ 0')
    }
    
    await page.close().catch(()=>{})
    browser.close().catch(()=>{})
  } finally {
    try { execSync('pkill -f "remote-debugging-port=9335"', { stdio: 'ignore' }) } catch {}
    await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }).catch(()=>{})
  }
}

main().then(() => process.exit(0)).catch(e => { console.log('❌', e.message?.substring(0,80)); process.exit(1) })
