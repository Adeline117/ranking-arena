/**
 * 轻量级全平台导入 - 纯 fetch，不需要浏览器
 * 
 * 直接调用各交易所已知的内部API端点
 * 通过 CF Worker proxy 绕过地区限制
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// Load .env.local
try {
  const envLocal = readFileSync('.env.local', 'utf8')
  for (const line of envLocal.split('\n')) {
    const m = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

async function f(url, opts = {}) {
  const tryFetch = async (u, o) => {
    const res = await fetch(u, { ...o, signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
  
  try { return await tryFetch(url, { headers: HEADERS, ...opts }) }
  catch {
    try { return await tryFetch(`${PROXY}/proxy?url=${encodeURIComponent(url)}`, { headers: HEADERS, ...opts }) }
    catch { return null }
  }
}

async function fPost(url, body, extraHeaders = {}) {
  const opts = { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) }
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) })
    if (res.status === 451 || !res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : null
  } catch {
    try {
      const res = await fetch(`${PROXY}/proxy?url=${encodeURIComponent(url)}`, { ...opts, signal: AbortSignal.timeout(15000) })
      const text = await res.text()
      return text ? JSON.parse(text) : null
    } catch { return null }
  }
}

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
function calcArenaScore(roi, pnl, dd, wr) {
  if (roi == null) return null
  let rs = Math.min(70, roi > 0 ? Math.log(1 + roi/100) * 25 : Math.max(-70, roi/100 * 50))
  let ds = dd != null ? Math.max(0, 15 * (1 - dd/100)) : 7.5
  let ss = wr != null ? Math.min(15, wr/100 * 15) : 7.5
  return clip(Math.round((rs + ds + ss) * 10) / 10, 0, 100)
}

async function saveTraders(source, traders, period) {
  const seasonId = period === '7D' ? 'current_7d' : period === '30D' ? 'current_30d' : 'current_90d'
  const now = new Date().toISOString()
  
  // Save sources
  const sourcesData = traders.map(t => ({
    source,
    source_trader_id: t.id,
    handle: t.name || t.id,
    avatar_url: t.avatar || null,
    profile_url: t.profileUrl || null,
    market_type: t.marketType || 'futures',
    is_active: true,
  }))
  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  // Save snapshots
  const snapsData = traders.map((t, i) => ({
    source,
    source_trader_id: t.id,
    season_id: seasonId,
    rank: i + 1,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    trades_count: t.tradesCount,
    follower_count: t.followers,
    arena_score: calcArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate),
    captured_at: now,
  }))
  
  const { error } = await supabase.from('trader_snapshots').upsert(snapsData, { onConflict: 'source,source_trader_id,season_id' })
  if (error) {
    let ok = 0
    for (const s of snapsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!e) ok++
    }
    return ok
  }
  return traders.length
}

// ============================================
// Binance Futures
// ============================================
async function importBinanceFutures() {
  console.log('\n🟡 Binance Futures...')
  for (const period of ['30D', '90D']) {
    let all = []
    for (let page = 1; page <= 25; page++) {
      const d = await fPost('https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list', {
        pageNumber: page, pageSize: 20, timeRange: period, dataType: 'ROI', favoriteOnly: false
      }, { Origin: 'https://www.binance.com', Referer: 'https://www.binance.com/en/copy-trading' })
      const list = d?.data?.list
      if (!list?.length) break
      for (const it of list) {
        all.push({
          id: it.leadPortfolioId || it.portfolioId || String(it.uid),
          name: it.nickname, avatar: it.userPhotoUrl,
          profileUrl: `https://www.binance.com/en/copy-trading/lead-details/${it.leadPortfolioId}`,
          roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
          pnl: it.pnl != null ? parseFloat(it.pnl) : null,
          winRate: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          maxDrawdown: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
          tradesCount: it.tradeCount, followers: it.copierNum,
        })
      }
      await sleep(500)
    }
    if (all.length) {
      const saved = await saveTraders('binance_futures', all, period)
      console.log(`  ${period}: ${saved}/${all.length}`)
    } else {
      console.log(`  ${period}: 0 (blocked)`)
    }
  }
}

// ============================================
// Binance Spot
// ============================================
async function importBinanceSpot() {
  console.log('\n🟡 Binance Spot...')
  for (const period of ['30D', '90D']) {
    let all = []
    for (let page = 1; page <= 25; page++) {
      const d = await fPost('https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list', {
        pageNumber: page, pageSize: 20, timeRange: period, dataType: 'ROI', favoriteOnly: false
      }, { Origin: 'https://www.binance.com' })
      const list = d?.data?.list
      if (!list?.length) break
      for (const it of list) {
        all.push({
          id: it.leadPortfolioId || it.portfolioId || String(it.uid),
          name: it.nickname, avatar: it.userPhotoUrl,
          roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
          pnl: it.pnl != null ? parseFloat(it.pnl) : null,
          winRate: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          marketType: 'spot',
        })
      }
      await sleep(500)
    }
    if (all.length) {
      const saved = await saveTraders('binance_spot', all, period)
      console.log(`  ${period}: ${saved}/${all.length}`)
    } else console.log(`  ${period}: 0 (blocked)`)
  }
}

// ============================================
// Bitget Futures - via /v1/trigger/trace
// ============================================
async function importBitgetFutures() {
  console.log('\n🟡 Bitget Futures...')
  for (const period of ['30D', '90D']) {
    let all = []
    for (let page = 1; page <= 25; page++) {
      const d = await f(`https://www.bitget.com/v1/trigger/trace/queryCopyTraderList?pageNo=${page}&pageSize=20&sort=ROI_DESC&range=${period.replace('D','d')}`)
      const list = d?.data?.list || d?.data?.traders || d?.data
      if (!Array.isArray(list) || !list.length) break
      for (const it of list) {
        all.push({
          id: it.traderId,
          name: it.nickName || it.nickname,
          avatar: it.headUrl || it.avatar,
          profileUrl: `https://www.bitget.com/copy-trading/trader/${it.traderId}/futures`,
          roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : (it.roi ? parseFloat(it.roi) : null),
          pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
          winRate: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          maxDrawdown: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
          tradesCount: it.totalOrderNum ? parseInt(it.totalOrderNum) : null,
          followers: it.currentCopyCount ? parseInt(it.currentCopyCount) : null,
        })
      }
      await sleep(400)
    }
    if (all.length) {
      const saved = await saveTraders('bitget_futures', all, period)
      console.log(`  ${period}: ${saved}/${all.length}`)
    } else console.log(`  ${period}: 0 (API changed or blocked)`)
  }
}

// ============================================
// MEXC - via contract API
// ============================================
async function importMEXC() {
  console.log('\n🟡 MEXC...')
  for (const period of ['30D']) {
    let all = []
    for (let page = 1; page <= 20; page++) {
      const d = await fPost('https://contract.mexc.com/api/v1/copytrading/v2/public/traders', {
        page, pageSize: 20, sortBy: 'roi', period: period.toLowerCase().replace('d',''),
      })
      const list = d?.data?.list || d?.data?.resultList || d?.data
      if (!Array.isArray(list) || !list.length) {
        // Try alternate endpoint
        const d2 = await f(`https://futures.mexc.com/api/v1/copytrading/public/leaderboard?page=${page}&limit=20&sort=roi&period=30`)
        const list2 = d2?.data?.list || d2?.data
        if (!Array.isArray(list2) || !list2.length) break
        for (const it of list2) {
          all.push({
            id: it.traderId || it.uid || String(it.id),
            name: it.nickname || it.name,
            avatar: it.avatar,
            roi: it.roi != null ? parseFloat(it.roi) : null,
            pnl: it.pnl != null ? parseFloat(it.pnl) : null,
            winRate: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
          })
        }
      } else {
        for (const it of list) {
          all.push({
            id: it.traderId || it.uid || String(it.id),
            name: it.nickname || it.name,
            avatar: it.avatar,
            roi: it.roi != null ? parseFloat(it.roi) : null,
            pnl: it.pnl != null ? parseFloat(it.pnl) : null,
            winRate: it.winRatio != null ? parseFloat(it.winRatio) * 100 : null,
            maxDrawdown: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
          })
        }
      }
      await sleep(500)
    }
    if (all.length) {
      const saved = await saveTraders('mexc', all, period)
      console.log(`  ${period}: ${saved}/${all.length}`)
    } else console.log(`  ${period}: 0 (blocked)`)
  }
}

// ============================================  
// KuCoin
// ============================================
async function importKuCoin() {
  console.log('\n🟡 KuCoin...')
  let all = []
  for (let page = 1; page <= 30; page++) {
    const d = await fPost('https://www.kucoin.com/_api/copy-trading/future/public/leaderboard', {
      currentPage: page, pageSize: 12, sortBy: 'ROI', sortDirection: 'DESC',
    }, { Origin: 'https://www.kucoin.com', Referer: 'https://www.kucoin.com/copy-trading/leaderboard' })
    const list = d?.data?.items || d?.data?.list
    if (!Array.isArray(list) || !list.length) break
    for (const it of list) {
      all.push({
        id: it.leaderId || it.uid || it.traderId,
        name: it.nickName || it.nickname,
        avatar: it.avatar,
        profileUrl: `https://www.kucoin.com/copy-trading/leader/${it.leaderId}`,
        roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
        pnl: it.pnl != null ? parseFloat(it.pnl) : null,
        winRate: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
        maxDrawdown: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
        followers: it.followerCount,
      })
    }
    await sleep(400)
  }
  if (all.length) {
    const saved = await saveTraders('kucoin', all, '30D')
    console.log(`  30D: ${saved}/${all.length}`)
  } else console.log(`  0 (blocked)`)
}

// ============================================
// CoinEx
// ============================================
async function importCoinEx() {
  console.log('\n🟡 CoinEx...')
  let all = []
  for (let page = 1; page <= 20; page++) {
    const d = await f(`https://www.coinex.com/res/copytrading/trader/ranking?page=${page}&limit=20&order_by=roi&direction=desc`)
    const list = d?.data?.list || d?.data?.traders
    if (!Array.isArray(list) || !list.length) break
    for (const it of list) {
      all.push({
        id: it.trader_id || it.uid,
        name: it.nickname || it.name,
        avatar: it.avatar,
        roi: it.roi != null ? parseFloat(it.roi) : null,
        pnl: it.total_profit != null ? parseFloat(it.total_profit) : null,
        winRate: it.win_rate != null ? parseFloat(it.win_rate) * 100 : null,
      })
    }
    await sleep(400)
  }
  if (all.length) {
    const saved = await saveTraders('coinex', all, '30D')
    console.log(`  30D: ${saved}/${all.length}`)
  } else console.log(`  0 (blocked)`)
}

// ============================================
// Weex
// ============================================
async function importWeex() {
  console.log('\n🟡 Weex...')
  let all = []
  for (let page = 1; page <= 10; page++) {
    const d = await fPost('https://www.weex.com/v1/copytrade/public/trader/list', {
      page, pageSize: 20, sortField: 'ROI', sortOrder: 'DESC',
    })
    const list = d?.data?.list || d?.data?.records
    if (!Array.isArray(list) || !list.length) break
    for (const it of list) {
      all.push({
        id: it.traderId || it.uid,
        name: it.nickname, avatar: it.avatar,
        roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
        pnl: it.pnl != null ? parseFloat(it.pnl) : null,
      })
    }
    await sleep(500)
  }
  if (all.length) {
    const saved = await saveTraders('weex', all, '30D')
    console.log(`  30D: ${saved}/${all.length}`)
  } else console.log(`  0 (blocked)`)
}

// ============================================
// Main
// ============================================
async function main() {
  console.log('🚀 轻量级全平台导入')
  console.log(`Proxy: ${PROXY}\n`)
  
  const target = process.argv[2]
  
  if (!target || target === 'all') {
    await importBinanceFutures()
    await importBinanceSpot()
    await importBitgetFutures()
    await importMEXC()
    await importKuCoin()
    await importCoinEx()
    await importWeex()
  } else {
    const fns = {
      binance: importBinanceFutures,
      binance_spot: importBinanceSpot,
      bitget: importBitgetFutures,
      mexc: importMEXC,
      kucoin: importKuCoin,
      coinex: importCoinEx,
      weex: importWeex,
    }
    if (fns[target]) await fns[target]()
    else console.log(`Unknown: ${target}`)
  }
  
  console.log('\n✅ Done!')
}

main().catch(console.error)
