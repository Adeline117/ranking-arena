#!/usr/bin/env node
/**
 * SSR/DOM 提取 - 等页面完全渲染后从 DOM 提取交易员数据
 * 同时拦截 API + 监听 WebSocket
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
function cs(roi, pnl, dd, wr) {
  if (roi == null) return null
  let r = Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50))
  let d = dd != null ? Math.max(0, 15 * (1 - dd / 100)) : 7.5
  let s = wr != null ? Math.min(15, wr / 100 * 15) : 7.5
  return clip(Math.round((r + d + s) * 10) / 10, 0, 100)
}

async function saveTraders(source, traders) {
  if (!traders.length) return 0
  const now = new Date().toISOString()
  for (let i = 0; i < traders.length; i += 50) {
    try { await supabase.from('trader_sources').upsert(
      traders.slice(i, i + 50).map(t => ({
        source, source_trader_id: t.id, handle: t.name || t.id,
        avatar_url: t.avatar || null, profile_url: t.profileUrl || null,
        market_type: 'futures', is_active: true,
      })), { onConflict: 'source,source_trader_id' }
    ) } catch {}
  }
  let saved = 0
  for (let i = 0; i < traders.length; i += 30) {
    const { error } = await supabase.from('trader_snapshots').upsert(
      traders.slice(i, i + 30).map((t, j) => ({
        source, source_trader_id: t.id, season_id: '30D', rank: i + j + 1,
        roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
        trades_count: t.trades, arena_score: cs(t.roi, t.pnl, t.dd, t.wr),
        captured_at: now,
      })), { onConflict: 'source,source_trader_id,season_id' }
    )
    if (!error) saved += Math.min(30, traders.length - i)
  }
  return saved
}

const platform = process.argv[2]
const CONFIGS = {
  bybit: { url: 'https://www.bybit.com/copyTrade/', source: 'bybit', waitSel: '[class*="card"], [class*="trader"], [class*="leader"]' },
  kucoin: { url: 'https://www.kucoin.com/copy-trading/leaderboard', source: 'kucoin', waitSel: '[class*="card"], [class*="trader"], [class*="leader"]' },
  bingx: { url: 'https://bingx.com/en/copy-trading/', source: 'bingx', waitSel: '[class*="card"], [class*="trader"]' },
  bitget: { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', source: 'bitget_futures', waitSel: '[class*="card"], [class*="trader"]' },
  xt: { url: 'https://www.xt.com/en/copy-trading/futures', source: 'xt', waitSel: '[class*="card"], [class*="trader"]' },
  blofin: { url: 'https://blofin.com/en/copy-trade', source: 'blofin', waitSel: '[class*="card"], [class*="trader"]' },
  phemex: { url: 'https://phemex.com/copy-trading', source: 'phemex', waitSel: '[class*="card"], [class*="trader"]' },
  weex: { url: 'https://www.weex.com/zh-CN/copy-trading', source: 'weex', waitSel: '[class*="card"], [class*="trader"]' },
}

if (!platform || !CONFIGS[platform]) {
  console.log('Usage: node browser-ssr-extract.mjs <' + Object.keys(CONFIGS).join('|') + '>')
  process.exit(1)
}

async function run() {
  const cfg = CONFIGS[platform]
  console.log(`📊 ${platform.toUpperCase()} — SSR extract`)
  
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) })
  await sleep(500)
  
  const browser = await chromium.launch({
    headless: false, executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=400,300', '--window-position=9999,9999', '--disable-gpu', '--disable-extensions', '--disable-dev-shm-usage'],
  })
  
  const apiTraders = new Map()
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    const page = await ctx.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm}', r => r.abort())
    
    // Intercept ALL responses
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const d = await res.json()
        const scan = (obj, depth = 0) => {
          if (depth > 4 || !obj) return
          if (Array.isArray(obj) && obj.length >= 2) {
            for (const it of obj) {
              const id = String(it.traderId || it.traderUid || it.uid || it.leaderId || it.copyTradeId || it.trader_id || it.id || '')
              if (!id || id === 'undefined' || apiTraders.has(id)) continue
              const hasTraderData = it.roi !== undefined || it.yieldRate !== undefined || it.nickName || it.nickname || it.winRate !== undefined
              if (!hasTraderData) continue
              
              let roi = null
              for (const k of ['yieldRate', 'roi', 'roiRate', 'totalRoi', 'pnlRate', 'returnRate']) {
                if (it[k] != null) { roi = parseFloat(it[k]); if (k === 'yieldRate' || (Math.abs(roi) < 10 && roi !== 0)) roi *= 100; break }
              }
              let pnl = null; for (const k of ['totalProfit', 'profit', 'pnl', 'totalPnl', 'total_profit']) if (it[k] != null) { pnl = parseFloat(it[k]); break }
              let wr = null; for (const k of ['winRate', 'win_rate', 'winRatio']) if (it[k] != null) { wr = parseFloat(it[k]); if (wr <= 1) wr *= 100; break }
              let dd = null; for (const k of ['maxDrawDown', 'maxDrawdown', 'mdd', 'max_drawdown']) if (it[k] != null) { dd = parseFloat(it[k]); if (Math.abs(dd) < 1) dd *= 100; break }
              
              apiTraders.set(id, {
                id, name: it.nickName || it.nickname || it.leaderName || it.name || '',
                avatar: it.headUrl || it.avatarUrl || it.avatar || it.userPhoto || null,
                roi, pnl, wr, dd,
                trades: parseInt(it.totalOrderNum || it.closedCount || it.tradeCount || 0) || null,
              })
            }
            if (apiTraders.size > 0) process.stdout.write(`\r  API: ${apiTraders.size}`)
          }
          if (typeof obj === 'object' && !Array.isArray(obj)) for (const v of Object.values(obj)) scan(v, depth + 1)
        }
        scan(d)
        
        // Immediate save
        if (apiTraders.size > 0 && apiTraders.size % 20 === 0) {
          const batch = [...apiTraders.values()]
          saveTraders(cfg.source, batch).then(n => process.stdout.write(` 💾${n}`)).catch(() => {})
        }
      } catch {}
    })
    
    await page.goto(cfg.url, { timeout: 45000, waitUntil: 'load' }).catch(() => {})
    
    // Wait CF
    for (let i = 0; i < 25; i++) {
      try {
        const t = await page.title()
        if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 2) {
          console.log(`  CF ✅ (${t.substring(0, 35)})`)
          break
        }
      } catch {}
      if (i === 24) { console.log('  CF ❌'); return }
      await sleep(1200)
    }
    
    // Wait for content to render
    await sleep(8000)
    
    // Try DOM extraction if no API data
    if (apiTraders.size === 0) {
      console.log('\n  API 拦截 0, 尝试 DOM...')
      
      const domData = await page.evaluate(() => {
        const results = []
        // Look for links to trader profiles
        const links = document.querySelectorAll('a[href*="trader"], a[href*="leader"], a[href*="copy"]')
        for (const link of links) {
          const href = link.href || ''
          const idMatch = href.match(/(?:trader|leader)\/([a-zA-Z0-9]+)/)
          if (!idMatch) continue
          
          // Get surrounding text for data
          const card = link.closest('[class*="card"], [class*="item"], [class*="row"], div') || link
          const text = card.innerText || ''
          const roiMatch = text.match(/([+-]?\d+\.?\d*)%/)
          
          results.push({
            id: idMatch[1],
            name: link.innerText?.trim()?.split('\n')[0] || '',
            roi: roiMatch ? parseFloat(roiMatch[1]) : null,
            href,
          })
        }
        return results.slice(0, 200)
      }).catch(() => [])
      
      if (domData.length) {
        console.log(`  DOM: ${domData.length} traders`)
        for (const d of domData) {
          if (!apiTraders.has(d.id)) {
            apiTraders.set(d.id, { id: d.id, name: d.name, roi: d.roi, profileUrl: d.href })
          }
        }
      }
    }
    
    // Scroll for more
    for (let i = 0; i < 5; i++) {
      try { await page.evaluate(() => document.body && window.scrollTo(0, document.body.scrollHeight)) } catch {}
      await sleep(2000)
    }
    
    // Final save
    const all = [...apiTraders.values()]
    console.log(`\n  总拦截: ${all.length}`)
    if (all.length) {
      const saved = await saveTraders(cfg.source, all)
      console.log(`  ✅ ${saved} 保存`)
    }
    
    await ctx.close()
  } finally {
    await browser.close().catch(() => {})
    await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) })
  }
}

run().catch(e => { console.error(e); process.exit(1) })
