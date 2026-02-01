/**
 * 快速 CF 绕过：headed Chrome 最小化 → 过 CF → 页内调 API → 关闭
 * 每个平台独立进程，极简内存
 */
import { readFileSync } from 'fs'
import { execSync } from 'child_process'
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
const CLASH_API = 'http://127.0.0.1:9090'

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
  const snapData = traders.map((t, i) => ({
    source, source_trader_id: t.id, season_id: seasonId, rank: i + 1,
    roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
    trades_count: t.trades, followers: t.followers,
    arena_score: calcScore(t.roi, t.pnl, t.dd, t.wr),
    captured_at: now,
  }))
  const { error } = await supabase.from('trader_snapshots').upsert(snapData, { onConflict: 'source,source_trader_id,season_id' })
  if (error) {
    let ok = 0
    for (const s of snapData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!e) ok++
    }
    return ok
  }
  return traders.length
}

let origMode = 'rule', origNode = ''
async function proxyOn() {
  const cfg = await (await fetch(`${CLASH_API}/configs`)).json()
  origMode = cfg.mode || 'rule'
  const px = await (await fetch(`${CLASH_API}/proxies/GLOBAL`)).json()
  origNode = px.now || ''
  const sg = (px.all || []).find(n => n.includes('新加坡'))
  if (sg) await fetch(`${CLASH_API}/proxies/GLOBAL`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sg }) })
  await fetch(`${CLASH_API}/configs`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) })
  await sleep(500)
}
async function proxyOff() {
  if (origNode) await fetch(`${CLASH_API}/proxies/GLOBAL`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: origNode }) })
  await fetch(`${CLASH_API}/configs`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: origMode }) })
}

async function cfBrowserFetch(siteUrl, apiCalls) {
  const browser = await chromium.launch({
    headless: false, channel: 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=400,300', '--window-position=9999,9999', '--disable-gpu'],
  })
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } })
    const page = await ctx.newPage()
    
    // Block images/fonts/css to save memory
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,css}', r => r.abort())
    
    console.log(`  打开 ${new URL(siteUrl).hostname}...`)
    await page.goto(siteUrl, { timeout: 25000, waitUntil: 'domcontentloaded' }).catch(() => {})
    
    // Wait CF
    let passed = false
    for (let i = 0; i < 15; i++) {
      const t = await page.title()
      if (!t.includes('moment') && !t.includes('Check')) { passed = true; break }
      await sleep(2000)
    }
    
    if (!passed) {
      console.log('  ❌ CF 未通过')
      return []
    }
    console.log('  ✅ CF 通过')
    
    // Execute API calls from page context
    const results = []
    for (const call of apiCalls) {
      try {
        const data = await page.evaluate(call.fn)
        if (data) results.push(...(Array.isArray(data) ? data : [data]))
        process.stdout.write(`\r  数据: ${results.length}`)
        await sleep(300)
      } catch (e) {
        break
      }
    }
    
    console.log('')
    await ctx.close()
    return results
  } finally {
    await browser.close()
  }
}

// ============================================
// Bitget
// ============================================
async function importBitget() {
  console.log('\n📊 Bitget Futures...')
  
  const apiCalls = []
  for (let p = 1; p <= 25; p++) {
    apiCalls.push({
      fn: `(async () => {
        const r = await fetch('/v1/trigger/trace/queryCopyTraderList', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageNo: ${p}, pageSize: 20, sort: 'ROI_DESC', range: '30d', languageType: 0 }),
        });
        const d = await r.json();
        const list = d?.data?.list || d?.data;
        if (!Array.isArray(list) || !list.length) return null;
        return list.map(it => ({
          id: it.traderId, name: it.nickName || it.nickname,
          avatar: it.headUrl, 
          profileUrl: 'https://www.bitget.com/copy-trading/trader/' + it.traderId + '/futures',
          roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : null,
          pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
          wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
          trades: it.totalOrderNum ? parseInt(it.totalOrderNum) : null,
          followers: it.currentCopyCount ? parseInt(it.currentCopyCount) : null,
        }));
      })()`
    })
  }
  
  const raw = await cfBrowserFetch('https://www.bitget.com/', apiCalls)
  const unique = [...new Map(raw.filter(t => t?.id).map(t => [t.id, t])).values()]
  console.log(`  总计: ${unique.length}`)
  if (unique.length) {
    const saved = await save('bitget_futures', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
}

// ============================================
// MEXC
// ============================================
async function importMEXC() {
  console.log('\n📊 MEXC...')
  
  const apiCalls = []
  for (let p = 1; p <= 20; p++) {
    apiCalls.push({
      fn: `(async () => {
        const r = await fetch('/api/platform/copyTrading/mainPage/traderList?page=${p}&pageSize=20&sort=YIELD');
        const d = await r.json();
        const list = d?.data?.list || d?.data?.items || d?.data;
        if (!Array.isArray(list) || !list.length) return null;
        return list.map(it => ({
          id: it.traderUid || it.uid || it.traderId || String(it.id || ''),
          name: it.nickName || it.nickname,
          avatar: it.avatarUrl || it.avatar,
          roi: it.roi != null ? parseFloat(it.roi) : null,
          pnl: it.profit != null ? parseFloat(it.profit) : null,
          wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          followers: it.copyCount,
        }));
      })()`
    })
  }
  
  const raw = await cfBrowserFetch('https://www.mexc.com/', apiCalls)
  const unique = [...new Map(raw.filter(t => t?.id).map(t => [t.id, t])).values()]
  console.log(`  总计: ${unique.length}`)
  if (unique.length) {
    const saved = await save('mexc', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
}

// ============================================
// KuCoin
// ============================================
async function importKuCoin() {
  console.log('\n📊 KuCoin...')
  
  const apiCalls = []
  for (let p = 1; p <= 30; p++) {
    apiCalls.push({
      fn: `(async () => {
        const r = await fetch('/_api/copy-trading/future/public/leaderboard/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPage: ${p}, pageSize: 12, sortBy: 'ROI', sortDirection: 'DESC' }),
        });
        const d = await r.json();
        const list = d?.data?.items || d?.data?.list;
        if (!Array.isArray(list) || !list.length) return null;
        return list.map(it => ({
          id: it.leaderId || it.uid,
          name: it.nickName || it.nickname,
          avatar: it.avatar,
          profileUrl: 'https://www.kucoin.com/copy-trading/leader/' + (it.leaderId || it.uid),
          roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
          pnl: it.pnl != null ? parseFloat(it.pnl) : null,
          wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
          followers: it.followerCount,
        }));
      })()`
    })
  }
  
  const raw = await cfBrowserFetch('https://www.kucoin.com/', apiCalls)
  const unique = [...new Map(raw.filter(t => t?.id).map(t => [t.id, t])).values()]
  console.log(`  总计: ${unique.length}`)
  if (unique.length) {
    const saved = await save('kucoin', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
}

// ============================================
// CoinEx
// ============================================
async function importCoinEx() {
  console.log('\n📊 CoinEx...')
  
  const apiCalls = []
  for (let p = 1; p <= 20; p++) {
    apiCalls.push({
      fn: `(async () => {
        const r = await fetch('/res/copytrading/trader/ranking?page=${p}&limit=20&order_by=roi&direction=desc');
        const d = await r.json();
        const list = d?.data?.list || d?.data?.traders || d?.data;
        if (!Array.isArray(list) || !list.length) return null;
        return list.map(it => ({
          id: it.trader_id || it.uid || String(it.id || ''),
          name: it.nickname || it.name,
          avatar: it.avatar,
          roi: it.roi != null ? parseFloat(it.roi) : null,
          pnl: it.total_profit != null ? parseFloat(it.total_profit) : null,
          wr: it.win_rate != null ? parseFloat(it.win_rate) * 100 : null,
        }));
      })()`
    })
  }
  
  const raw = await cfBrowserFetch('https://www.coinex.com/', apiCalls)
  const unique = [...new Map(raw.filter(t => t?.id).map(t => [t.id, t])).values()]
  console.log(`  总计: ${unique.length}`)
  if (unique.length) {
    const saved = await save('coinex', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
}

// ============================================
async function main() {
  const target = process.argv[2] || 'all'
  console.log(`🚀 CF Quick Bypass [${target}]`)
  
  await proxyOn()
  console.log('🌏 代理: 新加坡 (global)')
  
  const platforms = { bitget: importBitget, mexc: importMEXC, kucoin: importKuCoin, coinex: importCoinEx }
  
  try {
    if (target === 'all') {
      for (const [name, fn] of Object.entries(platforms)) {
        try { await fn() } catch (e) { console.log(`  ❌ ${name}: ${e.message}`) }
      }
    } else if (platforms[target]) {
      await platforms[target]()
    }
  } finally {
    await proxyOff()
    console.log('\n🔄 代理恢复')
  }
  console.log('✅ 完成!')
}

main().catch(async e => { console.error(e); await proxyOff() })
