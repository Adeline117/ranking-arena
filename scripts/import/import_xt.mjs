#!/usr/bin/env node
/**
 * XT 专用导入 — 通过浏览器过 CF，然后在页面内 fetch API 翻页
 * API: /fapi/user/v1/public/copy-trade/elite-leader-list-v2
 * 字段映射: accountId→id, incomeRate→roi, income→pnl, winRate→wr, maxRetraction→dd
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { execSync, spawn } from 'child_process'
import { chromium } from 'playwright'

import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/snap/bin/chromium')
const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '../../.env.local')
try { for (const l of readFileSync(envPath,'utf8').split('\n')) {
  const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]
}} catch{}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v,lo,hi) => Math.max(lo,Math.min(hi,v))
function cs(roi,p,d,w){if(roi==null)return null;return clip(Math.round((Math.min(70,roi>0?Math.log(1+roi/100)*25:Math.max(-70,roi/100*50))+(d!=null?Math.max(0,15*(1-d/100)):7.5)+(w!=null?Math.min(15,w/100*15):7.5))*10)/10,0,100)}

const PORT = 9337

async function launchChrome() {
  try { execSync('pkill -f "remote-debugging-port=9337"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-xt-profile',
    '--no-first-run','--disable-extensions','--disable-sync','--disable-gpu',
    '--window-size=400,300','--window-position=9999,9999',
    '--proxy-server=http://127.0.0.1:7890','about:blank',
  ], { stdio: 'ignore', detached: true }).unref()
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch {}
  }
  throw new Error('Chrome timeout')
}

function parseTrader(it) {
  const id = String(it.accountId || '')
  if (!id) return null
  
  // incomeRate is decimal: 1.0852 = 108.52%
  let roi = null
  if (it.incomeRate != null) {
    roi = parseFloat(it.incomeRate) * 100
  }
  
  let pnl = null
  if (it.income != null) pnl = parseFloat(it.income)
  
  let wr = null
  if (it.winRate != null) {
    wr = parseFloat(it.winRate)
    if (wr <= 1) wr *= 100
  }
  
  let dd = null
  if (it.maxRetraction != null) {
    dd = Math.abs(parseFloat(it.maxRetraction))
    if (dd <= 1 && dd > 0) dd *= 100
  }
  
  return {
    id,
    name: it.nickName || '',
    avatar: it.avatar || null,
    roi, pnl, wr, dd,
    trades: null,
    followers: parseInt(it.followerCount || 0) || null,
    tradeDays: it.tradeDays || null,
  }
}

async function main() {
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }).catch(()=>{})
  await sleep(1000)
  
  await launchChrome()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0] || await browser.newContext()
  const page = await ctx.newPage()
  
  // Load page to establish cookies/session
  await page.goto('https://www.xt.com/en/copy-trading/futures', { timeout: 45000, waitUntil: 'load' }).catch(()=>{})
  
  // CF wait
  let cfOk = false
  for (let i = 0; i < 30; i++) {
    const t = await page.title().catch(() => '')
    if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
    await sleep(1500)
  }
  if (!cfOk) { console.log('❌ CF'); process.exit(1) }
  console.log('CF ✅')
  
  await sleep(5000)
  
  const traders = new Map()
  
  // Fetch all sort types with pagination
  // sortTypes discovered: INCOME_RATE, FOLLOWER_COUNT, etc.
  // Use different sort params to get different traders
  const sortTypes = ['INCOME_RATE', 'FOLLOWER_COUNT', 'INCOME', 'FOLLOWER_PROFIT']
  const periods = [7, 30, 90] // days
  
  for (const days of periods) {
    for (const sortType of sortTypes) {
      let page_num = 1
      let hasMore = true
      let emptyStreak = 0
      
      while (hasMore && page_num <= 50 && emptyStreak < 2) {
        const result = await page.evaluate(async ({ days, sortType, size, pageNum }) => {
          try {
            // Build URL with pagination
            const url = `https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?size=${size}&days=${days}&sotType=${sortType}&pageNo=${pageNum}`
            const r = await fetch(url, { credentials: 'include' })
            return await r.json()
          } catch(e) { return { _err: e.message } }
        }, { days, sortType, size: 50, pageNum: page_num }).catch(() => null)
        
        if (!result || result._err || result.returnCode !== 0) {
          // Try alternative: the API might return the result grouped
          if (page_num === 1) {
            // First page - check if data is in result array
            const grouped = result?.result
            if (Array.isArray(grouped)) {
              for (const group of grouped) {
                if (group.items && group.items.length > 0) {
                  let newCount = 0
                  for (const it of group.items) {
                    const t = parseTrader(it)
                    if (t && !traders.has(t.id)) { traders.set(t.id, t); newCount++ }
                  }
                  hasMore = group.hasMore === true
                  if (newCount === 0) emptyStreak++
                  else emptyStreak = 0
                  process.stdout.write(`\r  ${days}d ${sortType}: p${page_num} +${newCount} → ${traders.size}`)
                }
              }
            }
          }
          break
        }
        
        // Parse result - could be direct array or grouped
        let items = []
        if (Array.isArray(result.result)) {
          // Grouped format: [{sotType, hasMore, items}]
          for (const group of result.result) {
            if (group.items) items.push(...group.items)
            if (group.hasMore === false) hasMore = false
          }
        } else if (result.result?.items) {
          items = result.result.items
          hasMore = result.result.hasMore !== false
        } else if (result.result?.list) {
          items = result.result.list
          hasMore = items.length >= 50
        }
        
        if (items.length === 0) { emptyStreak++; break }
        
        let newCount = 0
        for (const it of items) {
          const t = parseTrader(it)
          if (t && !traders.has(t.id)) { traders.set(t.id, t); newCount++ }
        }
        
        if (newCount === 0) emptyStreak++
        else emptyStreak = 0
        
        process.stdout.write(`\r  ${days}d ${sortType}: p${page_num} +${newCount} → ${traders.size}`)
        page_num++
        await new Promise(r => setTimeout(r, 300 + Math.random() * 500))
      }
    }
    console.log()
  }
  
  // Also try the main list endpoint that shows all traders
  console.log('Trying all-traders endpoint...')
  for (let pg = 1; pg <= 100; pg++) {
    const result = await page.evaluate(async ({ pg }) => {
      try {
        // Try various endpoint patterns
        for (const url of [
          `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-list?pageNo=${pg}&pageSize=50`,
          `https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list?pageNo=${pg}&pageSize=50`,
        ]) {
          const r = await fetch(url, { credentials: 'include' })
          const d = await r.json()
          if (d.returnCode === 0 && d.result) return d
        }
        return null
      } catch { return null }
    }, { pg }).catch(() => null)
    
    if (!result) break
    
    let items = []
    if (Array.isArray(result.result)) {
      for (const g of result.result) if (g.items) items.push(...g.items)
    } else if (result.result?.list) items = result.result.list
    else if (result.result?.items) items = result.result.items
    
    if (items.length === 0) break
    
    let newCount = 0
    for (const it of items) {
      const t = parseTrader(it)
      if (t && !traders.has(t.id)) { traders.set(t.id, t); newCount++ }
    }
    process.stdout.write(`\r  all p${pg}: +${newCount} → ${traders.size}`)
    if (newCount === 0) break
    await new Promise(r => setTimeout(r, 300))
  }
  console.log()
  
  // Save
  if (traders.size > 0) {
    const all = [...traders.values()]
    const now = new Date().toISOString()
    let saved = 0
    
    for (let i=0;i<all.length;i+=50)
      try{await sb.from('trader_sources').upsert(all.slice(i,i+50).map(t=>({
        source:'xt', source_trader_id:t.id, handle:t.name||t.id,
        avatar_url:t.avatar, market_type:'futures', is_active:true,
        profile_url: `https://www.xt.com/en/copy-trading/futures/detail/${t.id}`,
      })),{onConflict:'source,source_trader_id'})}catch(e){console.log('src err:',e.message)}
    
    for (let i=0;i<all.length;i+=30){
      const{error}=await sb.from('trader_snapshots').upsert(all.slice(i,i+30).map((t,j)=>({
        source:'xt', source_trader_id:t.id, season_id:'30D',
        rank:i+j+1, roi:t.roi, pnl:t.pnl, win_rate:t.wr,
        max_drawdown:t.dd, trades_count:t.trades,
        arena_score:cs(t.roi,t.pnl,t.dd,t.wr), captured_at:now
      })),{onConflict:'source,source_trader_id,season_id'})
      if(!error)saved+=Math.min(30,all.length-i)}
    
    console.log(`✅ ${saved} saved (${traders.size} unique)`)
  } else {
    console.log('❌ 0')
  }
  
  await page.close().catch(()=>{})
  browser.close().catch(()=>{})
  try { execSync('pkill -f "remote-debugging-port=9337"', { stdio: 'ignore' }) } catch {}
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }).catch(()=>{})
}

main().then(() => process.exit(0)).catch(e => { console.log('❌', e.message?.substring(0,80)); process.exit(1) })
