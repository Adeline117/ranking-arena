#!/usr/bin/env node
/**
 * 精准浏览器导入 — 每个平台独立处理 + 即时保存
 * 关键：拦截到数据立即保存，不等进程结束
 */
import { readFileSync } from 'fs'
import { chromium } from 'playwright'
import { clip, sb, sleep } from './lib/index.mjs'

function calcScore(roi, pnl, dd, wr) {
  if (roi == null) return null
  let rs = Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50))
  let ds = dd != null ? Math.max(0, 15 * (1 - dd / 100)) : 7.5
  let ss = wr != null ? Math.min(15, wr / 100 * 15) : 7.5
  return clip(Math.round((rs + ds + ss) * 10) / 10, 0, 100)
}

// Save immediately per batch - no waiting
async function saveNow(source, traders, seasonId) {
  if (!traders.length) return 0
  const now = new Date().toISOString()
  
  try { await sb.from('trader_sources').upsert(
    traders.map(t => ({
      source, source_trader_id: t.id, handle: t.name || t.id,
      avatar_url: t.avatar || null, profile_url: t.profileUrl || null,
      market_type: 'futures', is_active: true,
    })), { onConflict: 'source,source_trader_id' }
  )} catch {}
  
  const snaps = traders.map((t, i) => ({
    source, source_trader_id: t.id, season_id: seasonId, rank: i + 1,
    roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
    trades_count: t.trades, followers: t.followers,
    arena_score: calcScore(t.roi, t.pnl, t.dd, t.wr),
    captured_at: now,
  }))
  
  let ok = 0
  for (let i = 0; i < snaps.length; i += 30) {
    const { error } = await sb.from('trader_snapshots').upsert(snaps.slice(i, i + 30), { onConflict: 'source,source_trader_id,season_id' })
    if (!error) ok += Math.min(30, snaps.length - i)
  }
  return ok
}

// ==================== MEXC ====================
function extractMEXC(item) {
  const id = String(item.traderId || item.uid || item.id || item.userId || '')
  if (!id) return null
  const name = item.nickName || item.nickname || item.name || item.displayName || ''
  if (!name || name.includes('*****')) return null
  
  let roi = parseFloat(item.roi || item.totalRoi || item.pnlRate || 0)
  if (Math.abs(roi) < 10 && roi !== 0) roi *= 100
  
  let avatar = item.avatar || item.avatarUrl || item.headImg || item.userPhoto || null
  if (avatar && (avatar.includes('/banner/') || avatar.includes('placeholder'))) avatar = null
  
  return {
    id, name, avatar,
    roi: roi || null,
    pnl: parseFloat(item.pnl || item.totalPnl || item.profit || 0) || null,
    wr: item.winRate != null ? (parseFloat(item.winRate) > 1 ? parseFloat(item.winRate) : parseFloat(item.winRate) * 100) : null,
    dd: parseFloat(item.mdd || item.maxDrawdown || 0) || null,
    followers: parseInt(item.followerCount || item.copierCount || 0) || null,
  }
}

// ==================== KuCoin ====================
function extractKuCoin(item) {
  const id = item.leaderId || item.uid || item.traderUid || ''
  if (!id) return null
  const name = item.nickName || item.nickname || ''
  
  return {
    id, name, avatar: item.avatar || null,
    profileUrl: `https://www.kucoin.com/copy-trading/leader/${id}`,
    roi: item.roi != null ? (Math.abs(parseFloat(item.roi)) < 10 ? parseFloat(item.roi) * 100 : parseFloat(item.roi)) : null,
    pnl: item.pnl != null ? parseFloat(item.pnl) : null,
    wr: item.winRate != null ? (parseFloat(item.winRate) <= 1 ? parseFloat(item.winRate) * 100 : parseFloat(item.winRate)) : null,
    dd: item.maxDrawdown != null ? (Math.abs(parseFloat(item.maxDrawdown)) < 1 ? parseFloat(item.maxDrawdown) * 100 : parseFloat(item.maxDrawdown)) : null,
    followers: parseInt(item.followerCount || 0) || null,
  }
}

// ==================== CoinEx ====================
function extractCoinEx(item) {
  const id = String(item.trader_id || item.uid || item.id || '')
  if (!id) return null
  
  return {
    id, name: item.nickname || item.name || '', avatar: item.avatar || null,
    roi: item.roi != null ? parseFloat(item.roi) : null,
    pnl: item.total_profit != null ? parseFloat(item.total_profit) : null,
    wr: item.win_rate != null ? (parseFloat(item.win_rate) <= 1 ? parseFloat(item.win_rate) * 100 : parseFloat(item.win_rate)) : null,
    dd: null, followers: null,
  }
}

// ==================== Bitget ====================
function extractBitget(item) {
  if (!item.traderId) return null
  
  return {
    id: item.traderId, name: item.nickName || item.nickname || '',
    avatar: item.headUrl || item.avatar || null,
    profileUrl: `https://www.bitget.com/copy-trading/trader/${item.traderId}/futures`,
    roi: item.yieldRate != null ? parseFloat(item.yieldRate) * 100 : null,
    pnl: item.totalProfit != null ? parseFloat(item.totalProfit) : null,
    wr: item.winRate != null ? (parseFloat(item.winRate) <= 1 ? parseFloat(item.winRate) * 100 : parseFloat(item.winRate)) : null,
    dd: item.maxDrawDown != null ? (Math.abs(parseFloat(item.maxDrawDown)) < 1 ? parseFloat(item.maxDrawDown) * 100 : parseFloat(item.maxDrawDown)) : null,
    trades: parseInt(item.totalOrderNum || 0) || null,
    followers: parseInt(item.currentCopyCount || 0) || null,
  }
}

// ==================== BingX ====================
function extractBingX(item) {
  const id = String(item.copyTradeId || item.uid || item.traderUid || item.id || '')
  if (!id) return null
  
  return {
    id, name: item.nickName || item.nickname || '', avatar: item.avatar || null,
    roi: item.roi != null ? parseFloat(item.roi) : null,
    pnl: item.profit != null ? parseFloat(item.profit) : null,
    wr: item.winRate != null ? (parseFloat(item.winRate) <= 1 ? parseFloat(item.winRate) * 100 : parseFloat(item.winRate)) : null,
    followers: parseInt(item.copyCount || item.followerCount || 0) || null,
  }
}

const CONFIGS = {
  mexc: { url: 'https://www.mexc.com/futures/copyTrade/home', source: 'mexc', extract: extractMEXC,
    isTraderArray: arr => arr.some(it => it.traderId || (it.uid && (it.roi !== undefined || it.pnlRate !== undefined || it.nickName))) },
  kucoin: { url: 'https://www.kucoin.com/copy-trading/leaderboard', source: 'kucoin', extract: extractKuCoin,
    isTraderArray: arr => arr.some(it => it.leaderId || (it.uid && it.roi !== undefined)) },
  coinex: { url: 'https://www.coinex.com/en/copy-trading/futures', source: 'coinex', extract: extractCoinEx,
    isTraderArray: arr => arr.some(it => it.trader_id || (it.uid && it.roi !== undefined)) },
  bitget: { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', source: 'bitget_futures', extract: extractBitget,
    isTraderArray: arr => arr.some(it => it.traderId && it.yieldRate !== undefined) },
  bingx: { url: 'https://bingx.com/en/copy-trading/', source: 'bingx', extract: extractBingX,
    isTraderArray: arr => arr.some(it => it.copyTradeId || (it.uid && it.roi !== undefined)) },
}

const platform = process.argv[2]
if (!platform || !CONFIGS[platform]) {
  console.log(`Usage: node browser-platform.mjs <${Object.keys(CONFIGS).join('|')}>`)
  process.exit(1)
}

async function run() {
  const cfg = CONFIGS[platform]
  console.log(`📊 ${platform.toUpperCase()}`)
  
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) })
  await sleep(500)
  
  const browser = await chromium.launch({
    headless: false, executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=600,400', '--window-position=9999,9999', '--disable-gpu', '--disable-extensions'],
  })
  
  const traderMap = new Map()
  let totalSaved = 0
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const page = await ctx.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm,ico}', r => r.abort())
    
    // Intercept JSON with platform-specific extraction
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const d = await res.json()
        
        const scan = (obj, depth = 0) => {
          if (depth > 4 || !obj) return
          if (Array.isArray(obj) && obj.length >= 2 && cfg.isTraderArray(obj)) {
            const batch = []
            for (const item of obj) {
              const t = cfg.extract(item)
              if (t && !traderMap.has(t.id)) {
                traderMap.set(t.id, t)
                batch.push(t)
              }
            }
            if (batch.length) {
              // Save immediately!
              saveNow(cfg.source, batch, '30D').then(n => {
                totalSaved += n
                process.stdout.write(`\r  拦截: ${traderMap.size} 💾${totalSaved}`)
              }).catch(() => {})
            }
          }
          if (typeof obj === 'object' && !Array.isArray(obj)) {
            for (const v of Object.values(obj)) scan(v, depth + 1)
          }
        }
        scan(d)
      } catch {}
    })
    
    await page.goto(cfg.url, { timeout: 40000, waitUntil: 'domcontentloaded' }).catch(() => {})
    
    // Wait CF
    for (let i = 0; i < 30; i++) {
      const t = await page.title()
      if (!t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 2) {
        console.log('  CF ✅')
        break
      }
      if (i === 29) { console.log('  CF ❌'); return }
      await sleep(1000)
    }
    
    await sleep(5000)
    
    // Scroll + paginate (limited)
    for (let i = 0; i < 8; i++) {
      try { await page.evaluate(() => document.body && window.scrollTo(0, document.body.scrollHeight)) } catch {}
      await sleep(2500)
      try {
        const next = page.locator('button:has-text("Next"), [class*="next"]:not([disabled])')
        if (await next.count()) { await next.first().click(); await sleep(2000) }
      } catch {}
    }
    
    console.log(`\n  完成: ${traderMap.size} 拦截, ${totalSaved} 保存`)
    await ctx.close()
  } catch(e) {
    console.log(`\n  Error: ${e.message}`)
    console.log(`  已保存: ${totalSaved}`)
  } finally {
    try { await browser.close() } catch {}
    await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) })
  }
}

run().catch(e => { console.error(e); process.exit(1) })
