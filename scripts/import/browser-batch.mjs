#!/usr/bin/env node
/**
 * 批量浏览器拦截 — 逐个平台，拦截 ALL JSON responses
 * 解决之前拦截规则太窄的问题
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

try { for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]; }} catch{}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v,lo,hi) => Math.max(lo,Math.min(hi,v))
function cs(roi,p,d,w){if(roi==null)return null;return clip(Math.round((Math.min(70,roi>0?Math.log(1+roi/100)*25:Math.max(-70,roi/100*50))+(d!=null?Math.max(0,15*(1-d/100)):7.5)+(w!=null?Math.min(15,w/100*15):7.5))*10)/10,0,100)}

async function save(source, traders) {
  if (!traders.length) return 0
  const now = new Date().toISOString()
  for (let i=0;i<traders.length;i+=50) try{await sb.from('trader_sources').upsert(traders.slice(i,i+50).map(t=>({source,source_trader_id:t.id,handle:t.name||t.id,avatar_url:t.avatar||null,market_type:'futures',is_active:true})),{onConflict:'source,source_trader_id'})}catch{}
  let saved=0
  for(let i=0;i<traders.length;i+=30){const{error}=await sb.from('trader_snapshots').upsert(traders.slice(i,i+30).map((t,j)=>({source,source_trader_id:t.id,season_id:'30D',rank:i+j+1,roi:t.roi,pnl:t.pnl,win_rate:t.wr,max_drawdown:t.dd,trades_count:t.trades,arena_score:cs(t.roi,t.pnl,t.dd,t.wr),captured_at:now})),{onConflict:'source,source_trader_id,season_id'});if(!error)saved+=Math.min(30,traders.length-i)}
  return saved
}

function extractTraders(obj, depth=0) {
  const results = []
  if (depth > 5 || !obj) return results
  if (Array.isArray(obj) && obj.length >= 2) {
    for (const it of obj) {
      if (!it || typeof it !== 'object') continue
      // Detect trader-like objects
      const keys = Object.keys(it)
      const hasId = keys.some(k => /trader|uid|leader|address|portfolio|userId|copyTrade/i.test(k)) || it.id
      const hasMetric = keys.some(k => /roi|pnl|yield|profit|winRate|return/i.test(k))
      const hasName = keys.some(k => /nick|name|displayName/i.test(k))
      if (!hasId || (!hasMetric && !hasName)) continue
      
      // Extract ID
      let id = ''
      for (const k of ['traderId','traderUid','uid','leaderId','encryptedUid','leadPortfolioId','copyTradeId','leaderMark','userId','trader_id','address','id']) {
        if (it[k] != null && String(it[k]).length > 1) { id = String(it[k]); break }
      }
      if (!id) continue
      
      // Extract metrics
      let roi = null
      for (const k of ['yieldRate','roi','roiRate','totalRoi','pnlRate','returnRate','periodRoi','copyTradeRoi','incomeRate']) {
        if (it[k] != null) { roi = parseFloat(it[k]); if (Math.abs(roi) < 20 && roi !== 0 && k !== 'roi') roi *= 100; break }
      }
      let pnl = null
      for (const k of ['totalProfit','profit','pnl','totalPnl','total_profit','realizedPnl','income']) {
        if (it[k] != null) { pnl = parseFloat(it[k]); break }
      }
      let wr = null
      for (const k of ['winRate','win_rate','winRatio','winCount']) {
        if (it[k] != null) { wr = parseFloat(it[k]); if (wr > 0 && wr <= 1) wr *= 100; break }
      }
      let dd = null
      for (const k of ['maxDrawDown','maxDrawdown','mdd','max_drawdown','drawDown']) {
        if (it[k] != null) { dd = Math.abs(parseFloat(it[k])); if (dd > 0 && dd < 1) dd *= 100; break }
      }
      
      results.push({
        id, name: it.nickName || it.nickname || it.leaderName || it.name || it.displayName || '',
        avatar: it.headUrl || it.avatarUrl || it.avatar || it.userPhoto || it.portraitUrl || null,
        roi, pnl, wr, dd,
        trades: parseInt(it.totalOrderNum || it.closedCount || it.tradeCount || it.orderCount || 0) || null,
      })
    }
  }
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const v of Object.values(obj)) results.push(...extractTraders(v, depth+1))
  }
  return results
}

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
