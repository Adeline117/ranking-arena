#!/usr/bin/env node
/**
 * 带翻页的浏览器抓取 — 专门解决 <100 平台的数据量问题
 * 策略:
 * 1. 拦截 JSON API 请求，分析翻页参数
 * 2. 在页面内 replay API 调用不同页码
 * 3. 同时尝试点击翻页按钮
 * 4. 多种排序方式获取不重复数据
 * 
 * 用法: node browser-paginated.mjs <platform> [--debug]
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
        roi, pnl, wr, dd, trades: parseInt(it.totalOrderNum||it.closedCount||it.tradeCount||0)||null,
        followers: parseInt(it.followerCount||it.followers||it.copierCount||0)||null })
    }
  }
  if (typeof obj === 'object' && !Array.isArray(obj)) for (const v of Object.values(obj)) results.push(...extractTraders(v, depth+1))
  return results
}

// Platform config with pagination strategies
const PLATFORMS = {
  bitget_f: {
    source: 'bitget_futures',
    urls: [
      'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0',
      'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=1',  // by PnL
      'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=2',  // by followers
    ],
    paginationSelector: '[class*="pagination"] button, [class*="pager"] button, [class*="page"] li, button[class*="next"]',
    scrollPages: 20,
    market_type: 'futures',
  },
  bitget_s: {
    source: 'bitget_spot',
    urls: [
      'https://www.bitget.com/copy-trading/spot',
      'https://www.bitget.com/copy-trading/spot?sort=1',
      'https://www.bitget.com/copy-trading/spot?sort=2',
    ],
    paginationSelector: '[class*="pagination"] button, [class*="pager"] button, button[class*="next"]',
    scrollPages: 20,
    market_type: 'spot',
  },
  bybit: {
    source: 'bybit',
    urls: [
      'https://www.bybit.com/copyTrade/',
      'https://www.bybit.com/copyTrade/?sortType=SORT_BY_ROI',
      'https://www.bybit.com/copyTrade/?sortType=SORT_BY_PNL',
      'https://www.bybit.com/copyTrade/?sortType=SORT_BY_WIN_RATE',
    ],
    paginationSelector: 'button[class*="next"], [class*="pagination"] button:last-child, [class*="page-next"]',
    scrollPages: 25,
    market_type: 'futures',
  },
  bingx: {
    source: 'bingx',
    urls: [
      'https://bingx.com/en/copy-trading/',
    ],
    scrollPages: 30,
    market_type: 'futures',
  },
  weex: {
    source: 'weex',
    urls: [
      'https://www.weex.com/zh-CN/copy-trading',
    ],
    scrollPages: 20,
    market_type: 'futures',
  },
  lbank: {
    source: 'lbank',
    urls: [
      'https://www.lbank.com/copy-trading',
    ],
    scrollPages: 20,
    market_type: 'futures',
  },
  phemex: {
    source: 'phemex',
    urls: [
      'https://phemex.com/copy-trading',
    ],
    scrollPages: 20,
    market_type: 'futures',
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
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-paginated-profile',
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
  for (let i=0;i<traders.length;i+=50) {
    try {
      await sb.from('trader_sources').upsert(
        traders.slice(i,i+50).map(t=>({
          source, source_trader_id:t.id, handle:t.name||t.id,
          avatar_url:t.avatar, market_type: market_type || 'futures', is_active:true
        })),
        {onConflict:'source,source_trader_id'}
      )
    } catch(e) { log('source upsert err:', e.message) }
  }
  for (let i=0;i<traders.length;i+=30) {
    const { error } = await sb.from('trader_snapshots').upsert(
      traders.slice(i,i+30).map((t,j)=>({
        source, source_trader_id:t.id, season_id:'30D',
        rank:i+j+1, roi:t.roi, pnl:t.pnl, win_rate:t.wr,
        max_drawdown:t.dd, trades_count:t.trades,
        arena_score:cs(t.roi,t.pnl,t.dd,t.wr), captured_at:now
      })),
      {onConflict:'source,source_trader_id,season_id'}
    )
    if (!error) saved += Math.min(30, traders.length - i)
  }
  return saved
}

async function collectFromPage(page, traders, apiCalls) {
  // Strategy 1: Click "next page" or pagination buttons repeatedly
  const paginationClicked = await page.evaluate(() => {
    // Look for pagination controls
    const selectors = [
      'button[class*="next"]', '[class*="next-page"]', '[class*="pagination"] li:last-child a',
      '[class*="pager"] button:last-child', 'a[rel="next"]', '[aria-label="Next"]',
      '[class*="ant-pagination-next"]', 'li.next a', '.page-next',
      // Chinese labels
      'button:has-text("下一页")', 'a:has-text("下一页")',
    ]
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel)
        if (el && !el.disabled && el.offsetParent !== null) {
          el.click()
          return sel
        }
      } catch {}
    }
    // Look by text
    const btns = [...document.querySelectorAll('button, a')]
    for (const b of btns) {
      const t = b.textContent?.trim()
      if (t === '>' || t === '›' || t === '下一页' || t === 'Next' || t === '»') {
        b.click()
        return 'text:' + t
      }
    }
    // Try numbered pages
    const pageNums = [...document.querySelectorAll('[class*="pagination"] li, [class*="pager"] span, [class*="page-item"]')]
    const current = pageNums.find(el => el.classList.toString().includes('active') || el.getAttribute('aria-current'))
    if (current) {
      const next = current.nextElementSibling
      if (next) { next.querySelector('a,button')?.click() || next.click(); return 'page-num-next' }
    }
    return null
  }).catch(() => null)

  if (paginationClicked) {
    log(`Clicked pagination: ${paginationClicked}`)
    await sleep(3000)
    return true
  }
  return false
}

async function replayApiPages(page, apiCalls, traders) {
  // Analyze intercepted API calls and replay with different page numbers
  for (const call of apiCalls) {
    const url = call.url
    const body = call.body
    
    // Detect pagination params in URL
    const urlPagination = url.match(/[?&](page(?:No|Index|Num)?|offset|cursor)=(\d+)/i)
    if (urlPagination) {
      const param = urlPagination[1]
      const currentPage = parseInt(urlPagination[2])
      const pageSize = url.match(/[?&](?:pageSize|limit|size)=(\d+)/i)?.[1] || '20'
      
      log(`Found URL pagination: ${param}=${currentPage}, pageSize=${pageSize}`)
      
      // Fetch pages 2-10
      for (let p = currentPage + 1; p <= Math.max(currentPage + 10, 10); p++) {
        const newUrl = url.replace(
          new RegExp(`([?&]${param}=)\\d+`),
          `$1${param === 'offset' ? (p - 1) * parseInt(pageSize) : p}`
        )
        log(`Fetching page ${p}: ${newUrl.substring(0, 100)}`)
        
        const result = await page.evaluate(async (fetchUrl) => {
          try {
            const r = await fetch(fetchUrl, { credentials: 'include' })
            return await r.json()
          } catch { return null }
        }, newUrl).catch(() => null)
        
        if (result) {
          const found = extractTraders(result)
          if (found.length === 0) { log(`Page ${p}: empty, stopping`); break }
          let newCount = 0
          for (const t of found) { if (!traders.has(t.id)) { traders.set(t.id, t); newCount++ } }
          process.stdout.write(`\r  API翻页 p${p}: +${newCount} (total: ${traders.size})`)
          if (newCount === 0) break
        } else { break }
        await sleep(500)
      }
    }
    
    // Detect pagination in POST body
    if (body && typeof body === 'string') {
      try {
        const bodyObj = JSON.parse(body)
        const pageParam = ['pageNo','pageNum','pageIndex','page','offset'].find(k => bodyObj[k] != null)
        const sizeParam = ['pageSize','limit','size'].find(k => bodyObj[k] != null)
        
        if (pageParam) {
          const currentPage = bodyObj[pageParam]
          const pageSize = sizeParam ? bodyObj[sizeParam] : 20
          log(`Found POST body pagination: ${pageParam}=${currentPage}, ${sizeParam}=${pageSize}`)
          
          for (let p = currentPage + 1; p <= Math.max(currentPage + 10, 10); p++) {
            const newBody = { ...bodyObj, [pageParam]: pageParam === 'offset' ? (p-1) * pageSize : p }
            
            const result = await page.evaluate(async ({ fetchUrl, fetchBody }) => {
              try {
                const r = await fetch(fetchUrl, {
                  method: 'POST', credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(fetchBody)
                })
                return await r.json()
              } catch { return null }
            }, { fetchUrl: url, fetchBody: newBody }).catch(() => null)
            
            if (result) {
              const found = extractTraders(result)
              if (found.length === 0) { log(`Page ${p}: empty, stopping`); break }
              let newCount = 0
              for (const t of found) { if (!traders.has(t.id)) { traders.set(t.id, t); newCount++ } }
              process.stdout.write(`\r  API翻页 p${p}: +${newCount} (total: ${traders.size})`)
              if (newCount === 0) break
            } else { break }
            await sleep(500)
          }
        }
      } catch {}
    }
  }
}

async function runUrl(browser, url, traders, apiCalls) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm,ico}', r => r.abort())
  
  const prevSize = traders.size

  // Intercept JSON responses AND record API call info
  page.on('request', req => {
    try {
      if (req.resourceType() !== 'fetch' && req.resourceType() !== 'xhr') return
      const url = req.url()
      if (url.includes('analytics') || url.includes('google') || url.includes('pixel') || url.includes('sentry')) return
      const method = req.method()
      apiCalls.push({
        url, method,
        body: method === 'POST' ? req.postData() : null,
        timestamp: Date.now()
      })
    } catch {}
  })
  
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const url = res.url()
      if (url.includes('analytics') || url.includes('google') || url.includes('pixel')) return
      const d = await res.json()
      const found = extractTraders(d)
      let newCount = 0
      for (const t of found) { if (!traders.has(t.id)) { traders.set(t.id, t); newCount++ } }
      if (found.length > 0) log(`Response ${url.substring(0,80)}: ${found.length} traders (${newCount} new)`)
    } catch {}
  })

  try {
    await page.goto(url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})
    
    // CF wait
    let cfOk = false
    for (let i = 0; i < 30; i++) {
      const t = await page.title().catch(() => '')
      if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
      await sleep(1500)
    }
    if (!cfOk) { console.log(`  CF ❌ for ${url}`); await ctx.close(); return }
    
    await sleep(8000)
    
    // Initial scroll to load data
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
      await sleep(2000)
    }
    
    // Try clicking pagination / load more
    let noNewDataStreak = 0
    for (let attempt = 0; attempt < 30; attempt++) {
      const before = traders.size
      
      // Try clicking next page
      const clicked = await collectFromPage(page, traders, apiCalls)
      if (clicked) {
        await sleep(3000)
        // Scroll after page change
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
          await sleep(1000)
        }
        if (traders.size > before) {
          noNewDataStreak = 0
          process.stdout.write(`\r  翻页 ${attempt+1}: ${traders.size} traders`)
        } else {
          noNewDataStreak++
          if (noNewDataStreak >= 3) { log('3 consecutive pages with no new data, stopping'); break }
        }
      } else {
        // Try "load more" button
        const loadMore = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, a, div[role="button"]')]
          const btn = btns.find(b => /more|load|加载|展开|查看更多/i.test(b.textContent?.trim()))
          if (btn) { btn.click(); return true }
          return false
        }).catch(() => false)
        
        if (loadMore) {
          await sleep(3000)
          if (traders.size > before) {
            noNewDataStreak = 0
            process.stdout.write(`\r  加载更多 ${attempt+1}: ${traders.size} traders`)
          } else {
            noNewDataStreak++
            if (noNewDataStreak >= 3) break
          }
        } else {
          // Continue scrolling
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
          await sleep(2000)
          if (traders.size === before) {
            noNewDataStreak++
            if (noNewDataStreak >= 3) break
          } else {
            noNewDataStreak = 0
          }
        }
      }
    }
    
    // If no pagination buttons worked, try API replay
    if (apiCalls.length > 0) {
      console.log(`\n  尝试 API 翻页 (${apiCalls.length} calls captured)...`)
      // Filter for data-bearing API calls
      const dataCalls = apiCalls.filter(c => 
        !c.url.includes('analytics') && !c.url.includes('google') &&
        !c.url.includes('config') && !c.url.includes('socket') &&
        (c.url.includes('trader') || c.url.includes('leader') || c.url.includes('copy') ||
         c.url.includes('rank') || c.url.includes('list') || c.url.includes('page'))
      )
      if (dataCalls.length) {
        await replayApiPages(page, dataCalls, traders)
      }
    }
    
    const newFromUrl = traders.size - prevSize
    console.log(`\n  ${url.substring(0, 60)}... → +${newFromUrl} (total: ${traders.size})`)
  } finally {
    await ctx.close()
  }
}

async function main() {
  // Enable proxy
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }).catch(()=>{})
  await sleep(1000)
  
  await launchChrome()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const traders = new Map()
  const apiCalls = []

  try {
    console.log(`📊 ${name.toUpperCase()} — 翻页模式`)
    
    // Visit each URL variant
    for (const url of cfg.urls) {
      apiCalls.length = 0 // Reset for each URL
      await runUrl(browser, url, traders, apiCalls)
      await sleep(2000)
    }
    
    // Save all
    if (traders.size > 0) {
      const saved = await save(cfg.source, traders, cfg.market_type)
      console.log(`\n✅ ${saved} 保存 (${traders.size} unique traders)`)
    } else {
      console.log('\n❌ 0')
    }
  } finally {
    try { browser.close().catch(()=>{}) } catch {}
    try { execSync('pkill -f "remote-debugging-port=9335"', { stdio: 'ignore' }) } catch {}
    await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }).catch(()=>{})
  }
}

main().then(() => process.exit(0)).catch(e => { console.log('❌', e.message?.substring(0,80)); process.exit(1) })
