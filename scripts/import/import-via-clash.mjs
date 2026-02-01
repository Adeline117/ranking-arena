/**
 * 通过 ClashX Pro 代理导入所有被封平台
 * 全自动：切全局代理 → 抓数据 → 恢复原模式
 * 
 * 使用: node scripts/import/import-via-clash.mjs [platform|all]
 */
import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'

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

const CLASH_API = 'http://127.0.0.1:9090'
const PROXY = 'http://127.0.0.1:7890'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// ============================================
// Clash proxy management
// ============================================
async function clashGet(path) {
  const res = await fetch(`${CLASH_API}${path}`)
  return res.json()
}

async function clashPut(path, body) {
  await fetch(`${CLASH_API}${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function clashPatch(path, body) {
  await fetch(`${CLASH_API}${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let originalMode = 'rule'
let originalGlobalProxy = ''

async function enableGlobalProxy() {
  // Save current state
  const config = await clashGet('/configs')
  originalMode = config.mode || 'rule'
  
  const proxies = await clashGet('/proxies/GLOBAL')
  originalGlobalProxy = proxies.now || ''
  
  // Find a non-US node (prefer Singapore > Japan > HK)
  const all = proxies.all || []
  const sgNode = all.find(n => n.includes('新加坡'))
  const jpNode = all.find(n => n.includes('日本'))
  const hkNode = all.find(n => n.includes('香港'))
  const node = sgNode || jpNode || hkNode
  
  if (!node) {
    console.error('❌ 未找到亚洲代理节点')
    return false
  }
  
  console.log(`🔄 切换代理: ${node}`)
  await clashPut('/proxies/GLOBAL', { name: node })
  await clashPatch('/configs', { mode: 'global' })
  await sleep(1000)
  
  // Verify
  const ip = await proxiedFetch('https://ipinfo.io/json').then(r => r.json())
  console.log(`🌏 代理IP: ${ip.country} ${ip.city} (${ip.org})`)
  
  if (ip.country === 'US') {
    console.warn('⚠️ 仍是美国IP，尝试其他节点...')
    const altNode = jpNode || hkNode || sgNode
    if (altNode && altNode !== node) {
      await clashPut('/proxies/GLOBAL', { name: altNode })
      await sleep(1000)
    }
  }
  
  return true
}

async function restoreProxy() {
  console.log(`\n🔄 恢复代理模式: ${originalMode}`)
  if (originalGlobalProxy) {
    await clashPut('/proxies/GLOBAL', { name: originalGlobalProxy })
  }
  await clashPatch('/configs', { mode: originalMode })
}

// ============================================
// Proxied HTTP fetch via ClashX
// ============================================
function proxiedFetch(url, opts = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    ...(opts.headers || {}),
  }
  
  let cmd = `curl -s -m 20 --compressed -x ${PROXY}`
  for (const [k, v] of Object.entries(headers)) {
    cmd += ` -H '${k}: ${v}'`
  }
  
  if (opts.method === 'POST' && opts.body) {
    cmd += ` -X POST -H 'Content-Type: application/json' -d '${opts.body.replace(/'/g, "'\\''")}'`
  }
  cmd += ` '${url}'`
  
  try {
    const out = execSync(cmd, { timeout: 25000, maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash' }).toString()
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(out),
      json: () => Promise.resolve(JSON.parse(out)),
    })
  } catch {
    return Promise.resolve({ ok: false, text: () => Promise.resolve(''), json: () => Promise.resolve(null) })
  }
}

async function pPost(url, body, extraHeaders = {}) {
  return proxiedFetch(url, { method: 'POST', body: JSON.stringify(body), headers: extraHeaders })
}

// ============================================
// DB helpers
// ============================================
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

function dedup(traders) {
  return [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
}

// ============================================
// Platform importers
// ============================================
async function importBinanceFutures() {
  console.log('\n📊 Binance Futures...')
  for (const period of ['30D', '90D']) {
    const all = []
    for (let p = 1; p <= 25; p++) {
      try {
        const res = await pPost('https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list', {
          pageNumber: p, pageSize: 20, timeRange: period, dataType: 'ROI', favoriteOnly: false,
        })
        const data = await res.json()
        if (!data?.data?.list?.length) break
        for (const it of data.data.list) {
          all.push({
            id: it.leadPortfolioId || String(it.uid),
            name: it.nickname, avatar: it.avatarUrl || it.userPhotoUrl,
            profileUrl: `https://www.binance.com/en/copy-trading/lead-details/${it.leadPortfolioId}`,
            roi: it.roi != null ? parseFloat(it.roi) : null,
            pnl: it.pnl != null ? parseFloat(it.pnl) : null,
            wr: it.winRate != null ? parseFloat(it.winRate) : null,
            dd: it.mdd != null ? parseFloat(it.mdd) : (it.maxDrawdown != null ? parseFloat(it.maxDrawdown) : null),
            trades: it.tradeCount, followers: it.currentCopyCount,
          })
        }
        process.stdout.write(`\r  ${period} 页${p}: ${all.length}`)
        await sleep(300)
      } catch { break }
    }
    const unique = dedup(all)
    console.log(`\n  ${period}: ${unique.length} 条`)
    if (unique.length) {
      const sid = period === '30D' ? 'current_30d' : 'current_90d'
      const saved = await save('binance_futures', unique, sid)
      console.log(`  ✅ ${saved} 条保存`)
    }
  }
}

async function importBinanceSpot() {
  console.log('\n📊 Binance Spot...')
  for (const period of ['30D']) {
    const all = []
    for (let p = 1; p <= 25; p++) {
      try {
        const res = await pPost('https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list', {
          pageNumber: p, pageSize: 20, timeRange: period, dataType: 'ROI', favoriteOnly: false,
        })
        const data = await res.json()
        if (!data?.data?.list?.length) break
        for (const it of data.data.list) {
          all.push({
            id: it.leadPortfolioId || String(it.uid),
            name: it.nickname, avatar: it.avatarUrl,
            roi: it.roi != null ? parseFloat(it.roi) : null,
            pnl: it.pnl != null ? parseFloat(it.pnl) : null,
            wr: it.winRate != null ? parseFloat(it.winRate) : null,
          })
        }
        process.stdout.write(`\r  ${period} 页${p}: ${all.length}`)
        await sleep(300)
      } catch { break }
    }
    const unique = dedup(all)
    console.log(`\n  ${period}: ${unique.length} 条`)
    if (unique.length) {
      const saved = await save('binance_spot', unique, 'current_30d', 'spot')
      console.log(`  ✅ ${saved} 条保存`)
    }
  }
}

async function importBitgetFutures() {
  console.log('\n📊 Bitget Futures...')
  for (const period of ['30D', '90D']) {
    const range = period === '30D' ? '30d' : '90d'
    const all = []
    for (let p = 1; p <= 25; p++) {
      try {
        const res = await pPost('https://www.bitget.com/v1/trigger/trace/queryCopyTraderList', {
          pageNo: p, pageSize: 20, sort: 'ROI_DESC', range, languageType: 0,
        }, { Origin: 'https://www.bitget.com', Referer: 'https://www.bitget.com/copy-trading' })
        const data = await res.json()
        const list = data?.data?.list || data?.data
        if (!Array.isArray(list) || !list.length) break
        for (const it of list) {
          all.push({
            id: it.traderId, name: it.nickName || it.nickname,
            avatar: it.headUrl || it.avatar,
            profileUrl: `https://www.bitget.com/copy-trading/trader/${it.traderId}/futures`,
            roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : null,
            pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
            wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
            dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
            trades: it.totalOrderNum ? parseInt(it.totalOrderNum) : null,
            followers: it.currentCopyCount ? parseInt(it.currentCopyCount) : null,
          })
        }
        process.stdout.write(`\r  ${period} 页${p}: ${all.length}`)
        await sleep(400)
      } catch { break }
    }
    const unique = dedup(all)
    console.log(`\n  ${period}: ${unique.length} 条`)
    if (unique.length) {
      const sid = period === '30D' ? 'current_30d' : 'current_90d'
      const saved = await save('bitget_futures', unique, sid)
      console.log(`  ✅ ${saved} 条保存`)
    }
  }
}

async function importBitgetSpot() {
  console.log('\n📊 Bitget Spot...')
  const all = []
  for (let p = 1; p <= 15; p++) {
    try {
      const res = await pPost('https://www.bitget.com/v1/trigger/trace/spot/queryCopyTraderList', {
        pageNo: p, pageSize: 20, sort: 'ROI_DESC', range: '30d', languageType: 0,
      }, { Origin: 'https://www.bitget.com' })
      const data = await res.json()
      const list = data?.data?.list || data?.data
      if (!Array.isArray(list) || !list.length) break
      for (const it of list) {
        all.push({
          id: it.traderId, name: it.nickName,
          avatar: it.headUrl,
          roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : null,
          pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
          wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
        })
      }
      process.stdout.write(`\r  页${p}: ${all.length}`)
      await sleep(400)
    } catch { break }
  }
  const unique = dedup(all)
  console.log(`\n  总计: ${unique.length} 条`)
  if (unique.length) {
    const saved = await save('bitget_spot', unique, 'current_30d', 'spot')
    console.log(`  ✅ ${saved} 条保存`)
  }
}

async function importMEXC() {
  console.log('\n📊 MEXC...')
  const all = []
  for (let p = 1; p <= 20; p++) {
    try {
      const res = await proxiedFetch(`https://www.mexc.com/api/platform/copyTrading/mainPage/traderList?page=${p}&pageSize=20&sort=YIELD`)
      const data = await res.json()
      const list = data?.data?.list || data?.data?.items || data?.data
      if (!Array.isArray(list) || !list.length) break
      for (const it of list) {
        all.push({
          id: it.traderUid || it.uid || it.traderId || String(it.id || ''),
          name: it.nickName || it.nickname,
          avatar: it.avatarUrl || it.avatar,
          roi: it.roi != null ? parseFloat(it.roi) : null,
          pnl: it.profit != null ? parseFloat(it.profit) : null,
          wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          followers: it.copyCount,
        })
      }
      process.stdout.write(`\r  页${p}: ${all.length}`)
      await sleep(500)
    } catch { break }
  }
  const unique = dedup(all)
  console.log(`\n  总计: ${unique.length} 条`)
  if (unique.length) {
    const saved = await save('mexc', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
}

async function importKuCoin() {
  console.log('\n📊 KuCoin...')
  const all = []
  for (let p = 1; p <= 30; p++) {
    try {
      const res = await pPost('https://www.kucoin.com/_api/copy-trading/future/public/leaderboard/query', {
        currentPage: p, pageSize: 12, sortBy: 'ROI', sortDirection: 'DESC',
      }, { Origin: 'https://www.kucoin.com', Referer: 'https://www.kucoin.com/copy-trading/leaderboard' })
      const data = await res.json()
      const list = data?.data?.items || data?.data?.list
      if (!Array.isArray(list) || !list.length) break
      for (const it of list) {
        all.push({
          id: it.leaderId || it.uid,
          name: it.nickName || it.nickname,
          avatar: it.avatar,
          profileUrl: `https://www.kucoin.com/copy-trading/leader/${it.leaderId}`,
          roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
          pnl: it.pnl != null ? parseFloat(it.pnl) : null,
          wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
          followers: it.followerCount,
        })
      }
      process.stdout.write(`\r  页${p}: ${all.length}`)
      await sleep(400)
    } catch { break }
  }
  const unique = dedup(all)
  console.log(`\n  总计: ${unique.length} 条`)
  if (unique.length) {
    const saved = await save('kucoin', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
}

async function importCoinEx() {
  console.log('\n📊 CoinEx...')
  const all = []
  for (let p = 1; p <= 20; p++) {
    try {
      const res = await proxiedFetch(`https://www.coinex.com/res/copytrading/trader/ranking?page=${p}&limit=20&order_by=roi&direction=desc`)
      const data = await res.json()
      const list = data?.data?.list || data?.data?.traders || data?.data
      if (!Array.isArray(list) || !list.length) break
      for (const it of list) {
        all.push({
          id: it.trader_id || it.uid || String(it.id || ''),
          name: it.nickname || it.name,
          avatar: it.avatar,
          roi: it.roi != null ? parseFloat(it.roi) : null,
          pnl: it.total_profit != null ? parseFloat(it.total_profit) : null,
          wr: it.win_rate != null ? parseFloat(it.win_rate) * 100 : null,
        })
      }
      process.stdout.write(`\r  页${p}: ${all.length}`)
      await sleep(500)
    } catch { break }
  }
  const unique = dedup(all)
  console.log(`\n  总计: ${unique.length} 条`)
  if (unique.length) {
    const saved = await save('coinex', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
}

// ============================================
// Main
// ============================================
async function main() {
  const target = process.argv[2] || 'all'
  console.log('🚀 ClashX Pro 代理导入')
  console.log(`目标: ${target}\n`)
  
  // Check ClashX is running
  try {
    await clashGet('/configs')
  } catch {
    console.error('❌ ClashX Pro 未运行')
    process.exit(1)
  }
  
  const ok = await enableGlobalProxy()
  if (!ok) { process.exit(1) }
  
  const platforms = {
    binance: importBinanceFutures,
    binance_spot: importBinanceSpot,
    bitget: importBitgetFutures,
    bitget_spot: importBitgetSpot,
    mexc: importMEXC,
    kucoin: importKuCoin,
    coinex: importCoinEx,
  }
  
  try {
    if (target === 'all') {
      for (const [name, fn] of Object.entries(platforms)) {
        try { await fn() } catch (e) { console.log(`  ❌ ${name}: ${e.message}`) }
      }
    } else if (platforms[target]) {
      await platforms[target]()
    } else {
      console.log(`可选: ${Object.keys(platforms).join(', ')}, all`)
    }
  } finally {
    await restoreProxy()
  }
  
  console.log('\n✅ 完成!')
}

main().catch(async (e) => {
  console.error(e)
  await restoreProxy()
})
