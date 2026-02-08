#!/usr/bin/env node
/**
 * 单平台浏览器抓取 — 极致内存优化
 * 用法: node browser-single.mjs <platform>
 * 每次只开一个 Chrome，抓完立即退出释放内存
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

try { for (const l of readFileSync('.env.local','utf8').split('\n')) {
  const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]
}} catch{}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v,lo,hi) => Math.max(lo,Math.min(hi,v))
function cs(roi,p,d,w){if(roi==null)return null;return clip(Math.round((Math.min(70,roi>0?Math.log(1+roi/100)*25:Math.max(-70,roi/100*50))+(d!=null?Math.max(0,15*(1-d/100)):7.5)+(w!=null?Math.min(15,w/100*15):7.5))*10)/10,0,100)}

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
      let pnl = null; for (const k of ['totalProfit','profit','pnl','totalPnl','total_profit','income']) { if (it[k] != null) { pnl = parseFloat(it[k]); break } }
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

const PLATFORMS = {
  xt:       { url: 'https://www.xt.com/en/copy-trading/futures', source: 'xt', scroll: 15 },
  mexc:     { url: 'https://www.mexc.com/copy-trading', source: 'mexc' },
  coinex:   { url: 'https://www.coinex.com/copy-trading', source: 'coinex' },
  kucoin:   { url: 'https://www.kucoin.com/copy-trading/leaderboard', source: 'kucoin' },
  bybit:    { url: 'https://www.bybit.com/copyTrade/', source: 'bybit' },
  bingx:    { url: 'https://bingx.com/en/copy-trading/', source: 'bingx' },
  bitget_f: { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', source: 'bitget_futures' },
  bitget_s: { url: 'https://www.bitget.com/copy-trading/spot', source: 'bitget_spot' },
  phemex:   { url: 'https://phemex.com/copy-trading', source: 'phemex' },
  weex:     { url: 'https://www.weex.com/zh-CN/copy-trading', source: 'weex' },
  lbank:    { url: 'https://www.lbank.com/copy-trading', source: 'lbank' },
  blofin:   { url: 'https://blofin.com/en/copy-trade', source: 'blofin' },
}

const name = process.argv[2]
if (!PLATFORMS[name]) { console.log('❌ unknown: ' + name); process.exit(1) }
const cfg = PLATFORMS[name]

async function main() {
  const traders = new Map()
  let savedTotal = 0

  const browser = await chromium.launch({
    headless: false, executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=400,300','--window-position=9999,9999',
      '--disable-gpu','--disable-extensions','--disable-dev-shm-usage',
      '--disable-background-networking','--disable-default-apps',
      '--js-flags=--max-old-space-size=256','--single-process'],
  })

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  const page = await ctx.newPage()
  // Block ALL heavy resources
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,mp4,webm,ico,css}', r => r.abort())
  await page.route('**/{analytics,tracking,pixel,gtag,gtm,facebook,twitter,sentry,segment,mixpanel,amplitude}*', r => r.abort())

  // Intercept JSON — save incrementally
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const d = await res.json()
      const found = extractTraders(d)
      let newCount = 0
      for (const t of found) { if (!traders.has(t.id)) { traders.set(t.id, t); newCount++ } }
      // Save every 20 new traders
      if (newCount > 0 && traders.size - savedTotal >= 20) {
        const batch = [...traders.values()].slice(savedTotal)
        const now = new Date().toISOString()
        for (let i=0;i<batch.length;i+=50) try{await sb.from('trader_sources').upsert(batch.slice(i,i+50).map(t=>({source:cfg.source,source_trader_id:t.id,handle:t.name||t.id,avatar_url:t.avatar,market_type:'futures',is_active:true})),{onConflict:'source,source_trader_id'})}catch{}
        for (let i=0;i<batch.length;i+=30) try{await sb.from('trader_snapshots').upsert(batch.slice(i,i+30).map((t,j)=>({source:cfg.source,source_trader_id:t.id,season_id:'30D',rank:savedTotal+i+j+1,roi:t.roi,pnl:t.pnl,win_rate:t.wr,max_drawdown:t.dd,trades_count:t.trades,arena_score:cs(t.roi,t.pnl,t.dd,t.wr),captured_at:now})),{onConflict:'source,source_trader_id,season_id'})}catch{}
        savedTotal = traders.size
      }
    } catch {}
  })

  try {
    await page.goto(cfg.url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})

    // CF challenge wait
    let cfOk = false
    for (let i = 0; i < 30; i++) {
      const t = await page.title().catch(() => '')
      if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
      await sleep(1500)
    }
    if (!cfOk) { console.log('❌ CF'); await browser.close(); process.exit(1) }

    await sleep(8000)

    // Scroll aggressively
    const scrollCount = cfg.scroll || 8
    for (let i = 0; i < scrollCount; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
      await sleep(2500)
    }

    // Final save
    if (traders.size > savedTotal) {
      const batch = [...traders.values()].slice(savedTotal)
      const now = new Date().toISOString()
      for (let i=0;i<batch.length;i+=50) try{await sb.from('trader_sources').upsert(batch.slice(i,i+50).map(t=>({source:cfg.source,source_trader_id:t.id,handle:t.name||t.id,avatar_url:t.avatar,market_type:'futures',is_active:true})),{onConflict:'source,source_trader_id'})}catch{}
      for (let i=0;i<batch.length;i+=30) try{await sb.from('trader_snapshots').upsert(batch.slice(i,i+30).map((t,j)=>({source:cfg.source,source_trader_id:t.id,season_id:'30D',rank:savedTotal+i+j+1,roi:t.roi,pnl:t.pnl,win_rate:t.wr,max_drawdown:t.dd,trades_count:t.trades,arena_score:cs(t.roi,t.pnl,t.dd,t.wr),captured_at:now})),{onConflict:'source,source_trader_id,season_id'})}catch{}
      savedTotal = traders.size
    }

    console.log(`✅ ${savedTotal}`)
  } catch (e) {
    // Still report partial saves
    if (savedTotal > 0) console.log(`⚠ ${savedTotal} (partial: ${e.message?.substring(0,30)})`)
    else console.log(`❌ ${e.message?.substring(0,50)}`)
  } finally {
    await browser.close().catch(()=>{})
    process.exit(0)
  }
}

main()
