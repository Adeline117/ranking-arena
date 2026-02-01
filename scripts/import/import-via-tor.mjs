/**
 * 通过 Tor SOCKS5 代理抓取被封平台
 * 前置条件：brew services start tor
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
  const snapData = traders.map((t, i) => ({
    source, source_trader_id: t.id, season_id: seasonId, rank: i + 1,
    roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
    trades_count: t.trades, follower_count: t.followers,
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

function curlTor(url, opts = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    ...(opts.headers || {}),
  }
  let cmd = `curl -s -m 20 --socks5-hostname 127.0.0.1:9050`
  for (const [k, v] of Object.entries(headers)) {
    cmd += ` -H '${k}: ${v}'`
  }
  if (opts.method === 'POST' && opts.body) {
    cmd += ` -X POST -H 'Content-Type: application/json' -d '${opts.body.replace(/'/g, "'\\''")}'`
  }
  cmd += ` '${url}'`
  try {
    return execSync(cmd, { timeout: 25000, maxBuffer: 5 * 1024 * 1024, shell: '/bin/bash' }).toString()
  } catch { return '' }
}

function torFetch(url, opts = {}) {
  const text = curlTor(url, opts)
  return { text, status: text ? 200 : 0, json: () => JSON.parse(text) }
}

function torPost(url, body, extraHeaders = {}) {
  return torFetch(url, { method: 'POST', body: JSON.stringify(body), headers: extraHeaders })
}

// ============================================
// Bitget Futures - v2 API
// ============================================
async function importBitget() {
  console.log('\n📊 Bitget Futures...')
  const all = []
  
  // Try multiple known Bitget API endpoints
  const endpoints = [
    { url: 'https://www.bitget.com/v1/trigger/trace/queryCopyTraderList', body: p => ({ pageNo: p, pageSize: 20, sort: 'ROI_DESC', range: '30d', languageType: 0 }) },
    { url: 'https://www.bitget.com/v1/trigger/trace/queryCopyTraderListV2', body: p => ({ pageNo: p, pageSize: 20, sort: 'ROI_DESC', range: '30d' }) },
    { url: 'https://api.bitget.com/api/v2/copy/spot-trader/profit-leader-list', body: null, qs: p => `pageNo=${p}&pageSize=20` },
  ]
  
  for (const ep of endpoints) {
    console.log(`  尝试: ${ep.url.split('/').pop()}...`)
    try {
      let res
      if (ep.body) {
        res = torPost(ep.url, ep.body(1), { Origin: 'https://www.bitget.com', Referer: 'https://www.bitget.com/copy-trading' })
      } else {
        res = torFetch(`${ep.url}?${ep.qs(1)}`)
      }
      const text = res.text
      if (text.includes('moment') || text.includes('challenge') || res.status === 403) {
        console.log(`    CF challenge / 403`)
        continue
      }
      const data = JSON.parse(text)
      const list = data?.data?.list || data?.data?.traders || (Array.isArray(data?.data) ? data.data : null)
      if (!list?.length) {
        console.log(`    空数据: ${text.substring(0, 100)}`)
        continue
      }
      
      console.log(`    ✓ 有数据! 开始分页...`)
      // This endpoint works - paginate
      for (let p = 1; p <= 25; p++) {
        try {
          let r
          if (ep.body) {
            r = torPost(ep.url, ep.body(p), { Origin: 'https://www.bitget.com' })
          } else {
            r = torFetch(`${ep.url}?${ep.qs(p)}`)
          }
          const d = r.json()
          const items = d?.data?.list || d?.data?.traders || (Array.isArray(d?.data) ? d.data : null)
          if (!items?.length) break
          for (const it of items) {
            all.push({
              id: it.traderId || it.traderUid || String(it.uid || ''),
              name: it.nickName || it.nickname,
              avatar: it.headUrl || it.avatar,
              profileUrl: it.traderId ? `https://www.bitget.com/copy-trading/trader/${it.traderId}/futures` : null,
              roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : (it.roi ? parseFloat(it.roi) : null),
              pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
              wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
              dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
              trades: it.totalOrderNum ? parseInt(it.totalOrderNum) : null,
              followers: it.currentCopyCount ? parseInt(it.currentCopyCount) : null,
            })
          }
          process.stdout.write(`\r    页${p}: ${all.length} 条`)
          await sleep(800)
        } catch { break }
      }
      break // Found working endpoint
    } catch (e) {
      console.log(`    错误: ${e.message}`)
    }
  }
  
  const unique = [...new Map(all.filter(t => t.id).map(t => [t.id, t])).values()]
  console.log(`\n  总计: ${unique.length}`)
  if (unique.length) {
    const saved = await save('bitget_futures', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
  return unique.length
}

// ============================================
// MEXC
// ============================================
async function importMEXC() {
  console.log('\n📊 MEXC...')
  const all = []
  
  const endpoints = [
    { url: 'https://contract.mexc.com/api/v1/copytrading/v2/public/traders', method: 'POST', body: p => ({ page: p, pageSize: 20, sortBy: 'roi', period: '30' }) },
    { url: 'https://futures.mexc.com/api/v1/copytrading/public/leaderboard', method: 'GET', qs: p => `page=${p}&limit=20&sort=roi&period=30` },
    { url: 'https://www.mexc.com/api/platform/copyTrading/mainPage/traderList', method: 'GET', qs: p => `page=${p}&pageSize=20&sort=YIELD` },
  ]
  
  for (const ep of endpoints) {
    console.log(`  尝试: ${ep.url.split('/').slice(-2).join('/')}...`)
    try {
      let res
      if (ep.method === 'POST') {
        res = torPost(ep.url, ep.body(1))
      } else {
        res = torFetch(`${ep.url}?${ep.qs(1)}`)
      }
      const text = res.text
      if (res.status >= 400 || text.includes('Access Denied') || text.includes('moment')) {
        console.log(`    封锁: ${res.status}`)
        continue
      }
      const data = JSON.parse(text)
      const list = data?.data?.list || data?.data?.items || data?.data?.resultList
      if (!list?.length) {
        console.log(`    空数据`)
        continue
      }
      
      console.log(`    ✓ 有数据!`)
      for (let p = 1; p <= 20; p++) {
        try {
          let r
          if (ep.method === 'POST') r = torPost(ep.url, ep.body(p))
          else r = torFetch(`${ep.url}?${ep.qs(p)}`)
          const d = r.json()
          const items = d?.data?.list || d?.data?.items || d?.data?.resultList
          if (!items?.length) break
          for (const it of items) {
            all.push({
              id: it.traderUid || it.uid || it.traderId || String(it.id || ''),
              name: it.nickName || it.nickname,
              avatar: it.avatarUrl || it.avatar,
              roi: it.roi != null ? parseFloat(it.roi) : null,
              pnl: it.profit != null ? parseFloat(it.profit) : null,
              wr: it.winRate != null ? parseFloat(it.winRate) * 100 : (it.winRatio != null ? parseFloat(it.winRatio) * 100 : null),
              dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
              followers: it.copyCount || it.followerCount,
            })
          }
          process.stdout.write(`\r    页${p}: ${all.length} 条`)
          await sleep(800)
        } catch { break }
      }
      break
    } catch (e) { console.log(`    错误: ${e.message}`) }
  }
  
  const unique = [...new Map(all.filter(t => t.id).map(t => [t.id, t])).values()]
  console.log(`\n  总计: ${unique.length}`)
  if (unique.length) {
    const saved = await save('mexc', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
  return unique.length
}

// ============================================
// KuCoin
// ============================================
async function importKuCoin() {
  console.log('\n📊 KuCoin...')
  const all = []
  
  for (let p = 1; p <= 30; p++) {
    try {
      const res = torPost('https://www.kucoin.com/_api/copy-trading/future/public/leaderboard/query', {
        currentPage: p, pageSize: 12, sortBy: 'ROI', sortDirection: 'DESC',
      }, { Origin: 'https://www.kucoin.com', Referer: 'https://www.kucoin.com/copy-trading/leaderboard' })
      const text = res.text
      if (res.status >= 400 || text.includes('moment')) {
        if (p === 1) console.log(`  封锁: ${res.status}`)
        break
      }
      const data = JSON.parse(text)
      const list = data?.data?.items || data?.data?.list
      if (!list?.length) {
        // Try alternate endpoint
        if (p === 1) {
          const res2 = torPost('https://www.kucoin.com/_api/copy-trading/future/public/leaderboard', {
            currentPage: 1, pageSize: 12, sortBy: 'ROI', sortDirection: 'DESC',
          }, { Origin: 'https://www.kucoin.com' })
          const d2 = res2.json()
          const l2 = d2?.data?.items || d2?.data?.list
          if (!l2?.length) { console.log(`  空数据`); break }
        } else break
      }
      for (const it of (list || [])) {
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
      process.stdout.write(`\r  页${p}: ${all.length} 条`)
      await sleep(600)
    } catch (e) { if (p === 1) console.log(`  错误: ${e.message}`); break }
  }
  
  const unique = [...new Map(all.filter(t => t.id).map(t => [t.id, t])).values()]
  console.log(`\n  总计: ${unique.length}`)
  if (unique.length) {
    const saved = await save('kucoin', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
  return unique.length
}

// ============================================
// CoinEx
// ============================================
async function importCoinEx() {
  console.log('\n📊 CoinEx...')
  const all = []
  
  for (let p = 1; p <= 20; p++) {
    try {
      const res = torFetch(`https://www.coinex.com/res/copytrading/trader/ranking?page=${p}&limit=20&order_by=roi&direction=desc`)
      const text = res.text
      if (res.status >= 400) { if (p === 1) console.log(`  封锁: ${res.status}`); break }
      const data = JSON.parse(text)
      const list = data?.data?.list || data?.data?.traders || data?.data
      if (!Array.isArray(list) || !list.length) {
        if (p === 1) console.log(`  空数据: ${text.substring(0, 100)}`)
        break
      }
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
      process.stdout.write(`\r  页${p}: ${all.length} 条`)
      await sleep(600)
    } catch (e) { if (p === 1) console.log(`  错误: ${e.message}`); break }
  }
  
  const unique = [...new Map(all.filter(t => t.id).map(t => [t.id, t])).values()]
  console.log(`\n  总计: ${unique.length}`)
  if (unique.length) {
    const saved = await save('coinex', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
  return unique.length
}

// ============================================
// Binance Futures + Spot (likely blocked even via Tor, but try)
// ============================================
async function importBinance() {
  console.log('\n📊 Binance Futures...')
  const all = []
  
  for (let p = 1; p <= 25; p++) {
    try {
      const res = torPost('https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list', {
        pageNumber: p, pageSize: 20, timeRange: '30D', dataType: 'ROI', favoriteOnly: false,
      })
      const text = res.text
      if (text.includes('forbidden') || text.includes('restricted') || res.status >= 400) {
        if (p === 1) console.log('  ⛔ Binance 封锁 Tor 出口')
        break
      }
      const data = JSON.parse(text)
      if (data?.code === 0 && data?.msg?.includes('restricted')) {
        console.log('  ⛔ 地区限制')
        break
      }
      const list = data?.data?.list
      if (!list?.length) break
      for (const it of list) {
        all.push({
          id: it.leadPortfolioId || String(it.uid),
          name: it.nickname, avatar: it.userPhotoUrl,
          profileUrl: `https://www.binance.com/en/copy-trading/lead-details/${it.leadPortfolioId}`,
          roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
          pnl: it.pnl != null ? parseFloat(it.pnl) : null,
          wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
          trades: it.tradeCount, followers: it.copierNum,
        })
      }
      process.stdout.write(`\r  页${p}: ${all.length} 条`)
      await sleep(500)
    } catch (e) { if (p === 1) console.log(`  错误: ${e.message}`); break }
  }
  
  const unique = [...new Map(all.filter(t => t.id).map(t => [t.id, t])).values()]
  console.log(`\n  总计: ${unique.length}`)
  if (unique.length) {
    const saved = await save('binance_futures', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  }
  return unique.length
}

// ============================================
async function main() {
  console.log('🚀 Tor SOCKS5 代理导入')
  
  // Verify Tor is running
  try {
    const res = torFetch('https://check.torproject.org/api/ip')
    const data = res.json()
    console.log(`Tor IP: ${data.IP} (IsTor: ${data.IsTor})`)
  } catch (e) {
    console.error('❌ Tor 未运行! 请先: brew services start tor')
    process.exit(1)
  }
  
  const target = process.argv[2] || 'all'
  const platforms = { binance: importBinance, bitget: importBitget, mexc: importMEXC, kucoin: importKuCoin, coinex: importCoinEx }
  
  let total = 0
  if (target === 'all') {
    for (const [name, fn] of Object.entries(platforms)) {
      try { total += await fn() } catch (e) { console.log(`❌ ${name}: ${e.message}`) }
    }
  } else if (platforms[target]) {
    total = await platforms[target]()
  }
  
  console.log(`\n✅ 完成! 总计 ${total} 条`)
}

main().catch(console.error)
