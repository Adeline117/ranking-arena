#!/usr/bin/env node
/**
 * 单平台浏览器导入 — 独立进程，headed Chrome + ClashX 代理
 * 用法: node browser-import-single.mjs <platform>
 * 
 * 设计: 每平台独立 node 进程，避免内存累积
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

function calcScore(roi, pnl, dd, wr) {
  if (roi == null) return null
  let rs = Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50))
  let ds = dd != null ? Math.max(0, 15 * (1 - dd / 100)) : 7.5
  let ss = wr != null ? Math.min(15, wr / 100 * 15) : 7.5
  return clip(Math.round((rs + ds + ss) * 10) / 10, 0, 100)
}

async function save(source, traders, seasonId, marketType = 'futures') {
  const now = new Date().toISOString()
  if (!traders.length) return 0
  const srcData = traders.map(t => ({
    source, source_trader_id: t.id, handle: t.name || t.id,
    avatar_url: t.avatar || null, profile_url: t.profileUrl || null,
    market_type: marketType, is_active: true,
  }))
  await supabase.from('trader_sources').upsert(srcData, { onConflict: 'source,source_trader_id' })
  
  // Split into chunks of 50 to avoid timeouts
  const snapData = traders.map((t, i) => ({
    source, source_trader_id: t.id, season_id: seasonId, rank: i + 1,
    roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
    trades_count: t.trades, followers: t.followers,
    arena_score: calcScore(t.roi, t.pnl, t.dd, t.wr),
    captured_at: now,
  }))
  
  let saved = 0
  for (let i = 0; i < snapData.length; i += 50) {
    const chunk = snapData.slice(i, i + 50)
    const { error } = await supabase.from('trader_snapshots').upsert(chunk, { onConflict: 'source,source_trader_id,season_id' })
    if (error) {
      for (const s of chunk) {
        const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
        if (!e) saved++
      }
    } else {
      saved += chunk.length
    }
  }
  return saved
}

// Platform configs
const PLATFORMS = {
  bitget: {
    url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0',
    source: 'bitget_futures',
    matchUrl: url => url.includes('bitget.com/v1') && (url.includes('trace') || url.includes('trader') || url.includes('copy') || url.includes('list') || url.includes('query')),
    extract: (data) => {
      const list = data?.data?.list || data?.data?.traders || (Array.isArray(data?.data) ? data.data : null)
      if (!Array.isArray(list)) return []
      return list.filter(it => it.traderId).map(it => ({
        id: it.traderId, name: it.nickName || it.nickname,
        avatar: it.headUrl || it.avatar,
        profileUrl: `https://www.bitget.com/copy-trading/trader/${it.traderId}/futures`,
        roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : null,
        pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
        wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
        dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
        trades: it.totalOrderNum ? parseInt(it.totalOrderNum) : null,
        followers: it.currentCopyCount ? parseInt(it.currentCopyCount) : null,
      }))
    },
  },
  mexc: {
    url: 'https://www.mexc.com/futures/copyTrade/home',
    source: 'mexc',
    matchUrl: url => (url.includes('copy') || url.includes('trade')) && (url.includes('trader') || url.includes('rank') || url.includes('leader') || url.includes('list') || url.includes('recommend') || url.includes('home')),
    extract: (data) => {
      const list = data?.data?.list || data?.data?.items || data?.data?.traders || data?.list
      if (!Array.isArray(list)) return []
      return list.filter(it => it.traderUid || it.uid || it.traderId).map(it => ({
        id: String(it.traderUid || it.uid || it.traderId || it.id || ''),
        name: it.nickName || it.nickname || it.name,
        avatar: it.avatarUrl || it.avatar,
        roi: it.roi != null ? parseFloat(it.roi) : (it.roiRate != null ? parseFloat(it.roiRate) * 100 : null),
        pnl: it.profit != null ? parseFloat(it.profit) : (it.pnl != null ? parseFloat(it.pnl) : null),
        wr: it.winRate != null ? parseFloat(it.winRate) * 100 : (it.winRatio != null ? parseFloat(it.winRatio) * 100 : null),
        dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
        followers: it.copyCount || it.followerCount,
      }))
    },
  },
  kucoin: {
    url: 'https://www.kucoin.com/copy-trading/leaderboard',
    source: 'kucoin',
    matchUrl: url => url.includes('leaderboard') || url.includes('leader') || (url.includes('copy') && url.includes('trading')),
    extract: (data) => {
      const list = data?.data?.items || data?.data?.list || data?.result?.items
      if (!Array.isArray(list)) return []
      return list.filter(it => it.leaderId || it.uid).map(it => ({
        id: it.leaderId || it.uid || it.traderId,
        name: it.nickName || it.nickname,
        avatar: it.avatar,
        profileUrl: `https://www.kucoin.com/copy-trading/leader/${it.leaderId || it.uid}`,
        roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
        pnl: it.pnl != null ? parseFloat(it.pnl) : null,
        wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
        dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
        followers: it.followerCount,
      }))
    },
  },
  coinex: {
    url: 'https://www.coinex.com/en/copy-trading/futures',
    source: 'coinex',
    matchUrl: url => url.includes('copy') && (url.includes('trader') || url.includes('ranking') || url.includes('list')),
    extract: (data) => {
      const list = data?.data?.list || data?.data?.traders || (Array.isArray(data?.data) ? data.data : null)
      if (!Array.isArray(list)) return []
      return list.filter(it => it.trader_id || it.uid || it.id).map(it => ({
        id: String(it.trader_id || it.uid || it.id || ''),
        name: it.nickname || it.name,
        avatar: it.avatar,
        roi: it.roi != null ? parseFloat(it.roi) : null,
        pnl: it.total_profit != null ? parseFloat(it.total_profit) : null,
        wr: it.win_rate != null ? parseFloat(it.win_rate) * 100 : null,
      }))
    },
  },
}

async function scrape(platformKey) {
  const config = PLATFORMS[platformKey]
  if (!config) { console.log(`Unknown: ${platformKey}`); return }
  
  console.log(`📊 ${platformKey} — ${config.url}`)
  
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=800,600', '--window-position=9999,9999', '--disable-gpu', '--disable-extensions'],
  })
  
  const traders = []
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const page = await ctx.newPage()
    
    // Block heavy resources
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm}', r => r.abort())
    
    // Intercept API responses
    page.on('response', async res => {
      const url = res.url()
      if (config.matchUrl(url)) {
        try {
          const ct = res.headers()['content-type'] || ''
          if (!ct.includes('json') && !ct.includes('text')) return
          const data = await res.json()
          const items = config.extract(data)
          if (items.length) {
            traders.push(...items)
            process.stdout.write(`\r  拦截: ${traders.length} 条`)
          }
        } catch {}
      }
    })
    
    // Navigate
    await page.goto(config.url, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {})
    
    // Wait for CF
    let cfPassed = false
    for (let i = 0; i < 20; i++) {
      const t = await page.title()
      if (!t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 2) {
        cfPassed = true
        console.log(`  CF ✅ (${t.substring(0, 40)})`)
        break
      }
      await sleep(2000)
    }
    
    if (!cfPassed) {
      console.log('  CF ❌')
      await ctx.close()
      return
    }
    
    // Wait for page to load data
    await sleep(5000)
    
    // Scroll to trigger lazy loading
    for (let i = 0; i < 15; i++) {
      try {
        await page.evaluate(() => {
          if (document.body) window.scrollTo(0, document.body.scrollHeight)
        })
      } catch {}
      await sleep(2000)
      
      // Try clicking pagination / load more
      try {
        const nextBtns = page.locator('button:has-text("Next"), button:has-text("Load More"), button:has-text("更多"), [class*="next"]:not([disabled]), .ant-pagination-next:not(.ant-pagination-disabled), [class*="loadMore"], [class*="load-more"]')
        if (await nextBtns.count()) {
          await nextBtns.first().click()
          await sleep(2000)
        }
      } catch {}
    }
    
    await ctx.close()
  } finally {
    await browser.close()
  }
  
  // Deduplicate
  const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
  console.log(`\n  总计: ${unique.length} 条`)
  
  if (unique.length) {
    const saved = await save(config.source, unique, '30D')
    console.log(`  ✅ ${saved} 条已保存`)
  } else {
    console.log('  ❌ 无数据')
  }
}

// Main
const platform = process.argv[2]
if (!platform) {
  console.log(`用法: node browser-import-single.mjs <${Object.keys(PLATFORMS).join('|')}>`)
  process.exit(1)
}

// Enable global proxy
fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) })
  .then(() => scrape(platform))
  .then(() => fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }))
  .then(() => { console.log('\n🔄 代理恢复'); process.exit(0) })
  .catch(e => { console.error(e); process.exit(1) })
