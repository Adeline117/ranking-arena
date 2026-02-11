#!/usr/bin/env node
/**
 * 快速浏览器抓取 — 过 CF → 拦截 API → 即时保存 → 快速退出
 * 每个平台独立运行，防止内存溢出
 */
import { readFileSync, writeFileSync } from 'fs'
import { chromium } from 'playwright'
import { clip, sb, sleep } from './lib/index.mjs'

function calcScore(roi, pnl, dd, wr) {
  if (roi == null) return null
  let rs = Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50))
  let ds = dd != null ? Math.max(0, 15 * (1 - dd / 100)) : 7.5
  let ss = wr != null ? Math.min(15, wr / 100 * 15) : 7.5
  return clip(Math.round((rs + ds + ss) * 10) / 10, 0, 100)
}

async function saveBatch(source, traders, seasonId) {
  const now = new Date().toISOString()
  if (!traders.length) return 0
  const srcData = traders.map(t => ({
    source, source_trader_id: t.id, handle: t.name || t.id,
    avatar_url: t.avatar || null, profile_url: t.profileUrl || null,
    market_type: 'futures', is_active: true,
  }))
  try { await sb.from('trader_sources').upsert(srcData, { onConflict: 'source,source_trader_id' }) } catch {}
  
  const snapData = traders.map((t, i) => ({
    source, source_trader_id: t.id, season_id: seasonId, rank: i + 1,
    roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
    trades_count: t.trades, followers: t.followers,
    arena_score: calcScore(t.roi, t.pnl, t.dd, t.wr),
    captured_at: now,
  }))
  
  let saved = 0
  for (let i = 0; i < snapData.length; i += 30) {
    const chunk = snapData.slice(i, i + 30)
    const { error } = await sb.from('trader_snapshots').upsert(chunk, { onConflict: 'source,source_trader_id,season_id' })
    saved += error ? 0 : chunk.length
  }
  return saved
}

const platform = process.argv[2]
if (!platform) { console.log('Usage: node browser-fast.mjs <mexc|kucoin|coinex|bitget|bingx>'); process.exit(1) }

const URLS = {
  mexc: 'https://www.mexc.com/futures/copyTrade/home',
  kucoin: 'https://www.kucoin.com/copy-trading/leaderboard',
  coinex: 'https://www.coinex.com/en/copy-trading/futures',
  bitget: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0',
  bingx: 'https://bingx.com/en/copy-trading/',
}

const SOURCES = {
  mexc: 'mexc', kucoin: 'kucoin', coinex: 'coinex',
  bitget: 'bitget_futures', bingx: 'bingx',
}

function extractTrader(it, platform) {
  // Universal trader extraction
  const id = String(it.traderId || it.traderUid || it.uid || it.leaderId || it.copyTradeId || it.trader_id || it.id || '')
  if (!id || id === 'undefined') return null
  const name = it.nickName || it.nickname || it.name || it.userName || ''
  const avatar = it.headUrl || it.avatarUrl || it.avatar || null
  
  let roi = null
  for (const k of ['yieldRate', 'roi', 'roiRate', 'returnRate']) {
    if (it[k] != null) { 
      roi = parseFloat(it[k])
      // If looks like decimal (0.xx), multiply by 100
      if (Math.abs(roi) < 10 && k !== 'roi') roi *= 100
      // yieldRate on Bitget is already decimal
      if (k === 'yieldRate') roi = parseFloat(it[k]) * 100
      break
    }
  }
  
  let pnl = null
  for (const k of ['totalProfit', 'profit', 'pnl', 'total_profit']) {
    if (it[k] != null) { pnl = parseFloat(it[k]); break }
  }
  
  let wr = null
  for (const k of ['winRate', 'win_rate', 'winRatio']) {
    if (it[k] != null) {
      wr = parseFloat(it[k])
      if (wr <= 1) wr *= 100
      break
    }
  }
  
  let dd = null
  for (const k of ['maxDrawDown', 'maxDrawdown', 'max_drawdown']) {
    if (it[k] != null) { 
      dd = parseFloat(it[k])
      if (Math.abs(dd) < 1) dd *= 100
      break
    }
  }
  
  const followers = it.currentCopyCount || it.copyCount || it.followerCount || it.followers || null
  const trades = it.totalOrderNum || it.tradeCount || it.trades_count || null
  
  let profileUrl = null
  if (platform === 'bitget') profileUrl = `https://www.bitget.com/copy-trading/trader/${id}/futures`
  if (platform === 'kucoin') profileUrl = `https://www.kucoin.com/copy-trading/leader/${id}`
  
  return { id, name, avatar, profileUrl, roi, pnl, wr, dd, trades: trades ? parseInt(trades) : null, followers: followers ? parseInt(followers) : null }
}

async function run() {
  console.log(`📊 ${platform.toUpperCase()} — browser-fast`)
  
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) })
  await sleep(500)
  
  const browser = await chromium.launch({
    headless: false, executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=600,400', '--window-position=9999,9999', '--disable-gpu', '--disable-extensions', '--js-flags=--max-old-space-size=256'],
  })
  
  const traderMap = new Map()
  let saveTimer = null
  let totalSaved = 0
  
  // Auto-save every 5 seconds
  const autoSave = async () => {
    const batch = [...traderMap.values()]
    if (batch.length > totalSaved) {
      const newOnes = batch.slice(totalSaved)
      const n = await saveBatch(SOURCES[platform], newOnes, '30D')
      totalSaved += n
      process.stdout.write(` 💾${totalSaved}`)
    }
  }
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const page = await ctx.newPage()
    
    // Block everything except essential
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm,ico}', r => r.abort())
    
    // Intercept JSON responses - find trader arrays
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const d = await res.json()
        
        const scan = (obj, depth = 0) => {
          if (depth > 4 || !obj) return
          if (Array.isArray(obj) && obj.length >= 2) {
            let found = 0
            for (const item of obj) {
              const t = extractTrader(item, platform)
              if (t && !traderMap.has(t.id)) {
                traderMap.set(t.id, t)
                found++
              }
            }
            if (found) process.stdout.write(`\r  拦截: ${traderMap.size}`)
          }
          if (typeof obj === 'object' && !Array.isArray(obj)) {
            for (const v of Object.values(obj)) scan(v, depth + 1)
          }
        }
        scan(d)
      } catch {}
    })
    
    // Navigate
    await page.goto(URLS[platform], { timeout: 40000, waitUntil: 'domcontentloaded' }).catch(() => {})
    
    // Wait CF
    let cfPassed = false
    for (let i = 0; i < 30; i++) {
      const t = await page.title()
      if (!t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 2) {
        cfPassed = true; break
      }
      await sleep(1000)
    }
    
    if (!cfPassed) {
      console.log('  CF ❌')
      await browser.close()
      return
    }
    console.log('  CF ✅')
    
    // Start auto-save timer
    saveTimer = setInterval(autoSave, 5000)
    
    // Wait for initial data
    await sleep(5000)
    
    // Scroll (limited to prevent OOM)
    for (let i = 0; i < 8; i++) {
      try { await page.evaluate(() => document.body && window.scrollTo(0, document.body.scrollHeight)) } catch {}
      await sleep(2500)
      
      // Try next page
      try {
        const next = page.locator('button:has-text("Next"), [class*="next"]:not([disabled]), li.ant-pagination-next:not(.ant-pagination-disabled) button')
        if (await next.count()) { await next.first().click(); await sleep(2000) }
      } catch {}
    }
    
    // Final save
    clearInterval(saveTimer)
    await autoSave()
    
    console.log(`\n  总计: ${traderMap.size} 条, 保存: ${totalSaved}`)
    await ctx.close()
  } catch(e) {
    console.log(`\n  Error: ${e.message}`)
    // Emergency save
    clearInterval(saveTimer)
    const batch = [...traderMap.values()]
    if (batch.length) {
      const n = await saveBatch(SOURCES[platform], batch, '30D')
      console.log(`  紧急保存: ${n}`)
    }
  } finally {
    clearInterval(saveTimer)
    await browser.close().catch(() => {})
    await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) })
  }
}

run().catch(e => { console.error(e); process.exit(1) })
