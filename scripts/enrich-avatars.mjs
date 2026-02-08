#!/usr/bin/env node
/**
 * enrich-avatars.mjs — Aggressive avatar enrichment for all CEX platforms
 * Fetches real avatars from exchange APIs and updates trader_sources.
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = {}

async function fetchJSON(url, options = {}) {
  try {
    const resp = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch { return null }
}

async function postJSON(url, body, extraHeaders = {}) {
  return fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
}

async function getMissing(source) {
  const all = []
  let from = 0
  while (true) {
    const { data } = await supabase.from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', source).is('avatar_url', null)
      .range(from, from + 999)
    if (!data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  return all
}

async function updateAvatar(id, url) {
  if (!url || url.includes('default') || url.includes('dicebear') || url.length < 10) return false
  const { error } = await supabase.from('trader_sources').update({ avatar_url: url }).eq('id', id)
  return !error
}

async function updateProfileUrl(id, url) {
  const { error } = await supabase.from('trader_sources').update({ profile_url: url }).eq('id', id)
  return !error
}

// ── Profile URL templates ──
const PROFILE_URLS = {
  binance_futures: id => `https://www.binance.com/en/copy-trading/lead-details/${id}`,
  binance_spot: id => `https://www.binance.com/en/copy-trading/lead-details/${id}`,
  bybit: id => `https://www.bybit.com/copyTrading/trade-center/detail?leaderMark=${id}`,
  bitget_futures: id => `https://www.bitget.com/copy-trading/trader/${id}`,
  bitget_spot: id => `https://www.bitget.com/copy-trading/trader/${id}`,
  mexc: id => `https://futures.mexc.com/copy-trading/trader/${id}`,
  coinex: id => `https://www.coinex.com/copy-trading/trader/${id}`,
  okx_futures: id => `https://www.okx.com/copy-trading/account/${id}`,
  okx_web3: id => `https://web3.okx.com/copy-trade/account/${id}`,
  htx_futures: id => `https://www.htx.com/futures/copy-trading/trader/${id}`,
  kucoin: id => `https://www.kucoin.com/copy-trading/leader/${id}`,
  weex: id => `https://www.weex.com/copy-trading/trader/${id}`,
  xt: id => `https://www.xt.com/en/copy-trading/trader/${id}`,
  lbank: id => `https://www.lbank.com/copy-trading/trader/${id}`,
  gateio: id => `https://www.gate.io/copy_trading/share?id=${id}`,
  pionex: id => `https://www.pionex.com/copy-trading/trader/${id}`,
}

// ══════════════════════════════════════
// Binance Futures — individual detail API
// ══════════════════════════════════════
async function enrichBinanceFutures() {
  const source = 'binance_futures'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  // Try bulk from leaderboard first
  const avatarMap = new Map()
  for (const timeRange of ['WEEKLY', 'MONTHLY', 'YEARLY']) {
    for (let page = 1; page <= 20; page++) {
      const data = await postJSON(
        'https://www.binance.com/bapi/futures/v3/public/future/leaderboard/getLeaderboardRank',
        { isShared: true, isTrader: false, periodType: timeRange, statisticsType: 'ROI', tradeType: 'PERPETUAL' },
        { Origin: 'https://www.binance.com' }
      )
      if (data?.data) {
        for (const t of data.data) {
          if (t.encryptedUid && t.userPhotoUrl) avatarMap.set(t.encryptedUid, t.userPhotoUrl)
        }
      }
      await sleep(300)
    }
  }
  console.log(`  Leaderboard bulk: ${avatarMap.size} avatars`)

  // Try copy trading list
  for (const timeRange of ['WEEKLY', 'MONTHLY']) {
    for (let page = 1; page <= 30; page++) {
      const data = await postJSON(
        'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
        { pageNumber: page, pageSize: 20, timeRange, dataType: 'ROI', favoriteOnly: false, hideFull: false, nickname: '', order: 'DESC' },
        { Origin: 'https://www.binance.com' }
      )
      const list = data?.data?.list
      if (!list?.length) break
      for (const t of list) {
        if (t.portfolioId && t.userPhotoUrl) avatarMap.set(t.portfolioId, t.userPhotoUrl)
        if (t.leadPortfolioId && t.userPhotoUrl) avatarMap.set(t.leadPortfolioId, t.userPhotoUrl)
      }
      await sleep(200)
    }
  }
  console.log(`  After copy-trade list: ${avatarMap.size} avatars`)

  let updated = 0
  // Apply bulk matches
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }

  // Individual lookups for remaining
  const remaining = traders.filter(t => !avatarMap.has(t.source_trader_id))
  let individualChecked = 0
  for (const t of remaining) {
    if (individualChecked >= 500) break // cap individual lookups
    const data = await postJSON(
      'https://www.binance.com/bapi/futures/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo',
      { encryptedUid: t.source_trader_id },
      { Origin: 'https://www.binance.com' }
    )
    const avatar = data?.data?.userPhotoUrl
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    individualChecked++
    if (individualChecked % 50 === 0) console.log(`  Individual: ${individualChecked}/${remaining.length}`)
    await sleep(500)
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// Binance Spot
// ══════════════════════════════════════
async function enrichBinanceSpot() {
  const source = 'binance_spot'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  let updated = 0
  for (const t of traders) {
    const data = await postJSON(
      'https://www.binance.com/bapi/futures/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo',
      { encryptedUid: t.source_trader_id },
      { Origin: 'https://www.binance.com' }
    )
    const avatar = data?.data?.userPhotoUrl
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    await sleep(500)
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// Bybit
// ══════════════════════════════════════
async function enrichBybit() {
  const source = 'bybit'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  const avatarMap = new Map()
  // Bulk from leaderboard
  for (let page = 1; page <= 30; page++) {
    const data = await fetchJSON(`https://api2.bybit.com/fapi/beehive/public/v2/common/leader/list?timeRange=7D&pageNo=${page}&pageSize=20&sortField=roiRate&sortType=DESC`)
    const list = data?.result?.leaderDetails
    if (!list?.length) break
    for (const t of list) {
      if (t.leaderMark && t.avatar) avatarMap.set(t.leaderMark, t.avatar)
    }
    await sleep(200)
  }
  console.log(`  Leaderboard: ${avatarMap.size} avatars`)

  let updated = 0
  for (const t of traders) {
    let avatar = avatarMap.get(t.source_trader_id)
    if (!avatar) {
      const data = await fetchJSON(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader-detail?leaderId=${t.source_trader_id}`)
      avatar = data?.result?.avatar || data?.result?.headUrl
      await sleep(200)
    }
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// Bitget Futures + Spot
// ══════════════════════════════════════
async function enrichBitget(source) {
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  let updated = 0
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    const data = await fetchJSON(`https://www.bitget.com/v1/trigger/trace/public/traderDetail?traderId=${t.source_trader_id}`)
    const avatar = data?.data?.traderImg || data?.data?.traderAvatar || data?.data?.avatar
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    if ((i + 1) % 100 === 0) console.log(`  Progress: ${i + 1}/${traders.length}`)
    await sleep(200)
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// OKX Futures
// ══════════════════════════════════════
async function enrichOKX() {
  const source = 'okx_futures'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  let updated = 0
  for (const t of traders) {
    const handle = t.handle || t.source_trader_id
    const data = await fetchJSON(`https://www.okx.com/priapi/v5/ecotrade/public/trader-detail?uniqueName=${encodeURIComponent(handle)}`)
    const avatar = data?.data?.[0]?.portLink || data?.data?.[0]?.avatar
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    await sleep(200)
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// OKX Web3
// ══════════════════════════════════════
async function enrichOKXWeb3() {
  const source = 'okx_web3'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  // Try bulk from copy-trade list
  const avatarMap = new Map()
  for (let page = 1; page <= 50; page++) {
    const data = await fetchJSON(`https://www.okx.com/priapi/v5/ecotrade/public/copy-trade/leader-list?pageNo=${page}&pageSize=20`)
    const list = data?.data
    if (!list?.length) break
    for (const t of list) {
      const id = t.uniqueCode || t.uniqueName
      const avatar = t.portLink || t.avatar
      if (id && avatar) avatarMap.set(id, avatar)
    }
    await sleep(200)
  }
  console.log(`  Bulk: ${avatarMap.size}`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get(t.handle)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// MEXC
// ══════════════════════════════════════
async function enrichMEXC() {
  const source = 'mexc'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  // Bulk from leaderboard
  const avatarMap = new Map()
  for (let page = 1; page <= 100; page++) {
    const data = await postJSON(
      'https://futures.mexc.com/api/v1/private/copytrading/trader/list/v2',
      { pageNum: page, pageSize: 50, sortField: 'profit_rate', sortDirection: 'desc', tradeType: 'USDT_M' }
    )
    const list = data?.data?.resultList || data?.data?.list
    if (!list?.length) break
    for (const t of list) {
      const id = t.traderId || t.traderUid
      const avatar = t.avatar || t.avatarUrl || t.headImg
      if (id && avatar) avatarMap.set(String(id), avatar)
    }
    await sleep(200)
  }
  console.log(`  Bulk: ${avatarMap.size}`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }

  // Individual for remaining (capped)
  const remaining = traders.filter(t => !avatarMap.has(t.source_trader_id)).slice(0, 500)
  for (let i = 0; i < remaining.length; i++) {
    const t = remaining[i]
    const data = await fetchJSON(`https://futures.mexc.com/api/v1/private/copytrading/trader/detail?traderId=${t.source_trader_id}`)
    const avatar = data?.data?.avatar || data?.data?.avatarUrl || data?.data?.headImg
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    if ((i + 1) % 100 === 0) console.log(`  Individual: ${i + 1}/${remaining.length}`)
    await sleep(300)
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// CoinEx
// ══════════════════════════════════════
async function enrichCoinEx() {
  const source = 'coinex'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  const avatarMap = new Map()
  for (let page = 1; page <= 50; page++) {
    const data = await fetchJSON(`https://www.coinex.com/res/copy-trading/traders?page=${page}&limit=50&sort_by=roi_rate&sort_direction=desc`)
    const list = data?.data?.records || data?.data
    if (!Array.isArray(list) || !list.length) break
    for (const t of list) {
      const id = t.user_id || t.trader_id
      const avatar = t.avatar || t.avatar_url
      if (id && avatar) avatarMap.set(String(id), avatar)
    }
    await sleep(200)
  }
  console.log(`  Bulk: ${avatarMap.size}`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// HTX Futures
// ══════════════════════════════════════
async function enrichHTX() {
  const source = 'htx_futures'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  const avatarMap = new Map()
  for (let page = 1; page <= 20; page++) {
    const data = await fetchJSON(`https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=50`)
    if (data?.code !== 200 || !data?.data?.itemList?.length) break
    for (const t of data.data.itemList) {
      if (t.imgUrl) {
        if (t.userSign) avatarMap.set(t.userSign, t.imgUrl)
        if (t.uid) avatarMap.set(String(t.uid), t.imgUrl)
      }
    }
    await sleep(300)
  }
  console.log(`  Bulk: ${avatarMap.size}`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// KuCoin
// ══════════════════════════════════════
async function enrichKuCoin() {
  const source = 'kucoin'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  const avatarMap = new Map()
  for (let page = 1; page <= 30; page++) {
    const data = await postJSON(
      'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US',
      { currentPage: page, pageSize: 20 }
    )
    const list = data?.data?.items
    if (!list?.length) break
    for (const t of list) {
      if (t.leadConfigId && t.avatar) avatarMap.set(String(t.leadConfigId), t.avatar)
    }
    await sleep(300)
  }
  console.log(`  Bulk: ${avatarMap.size}`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// Weex
// ══════════════════════════════════════
async function enrichWeex() {
  const source = 'weex'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  const avatarMap = new Map()
  for (let page = 1; page <= 30; page++) {
    const data = await fetchJSON(`https://www.weex.com/api/v1/copy-trading/trader/list?page=${page}&pageSize=50`)
    const list = data?.data?.list || data?.data
    if (!Array.isArray(list) || !list.length) break
    for (const t of list) {
      const id = t.traderId || t.uid
      const avatar = t.headPic || t.avatar || t.headUrl
      if (id && avatar) avatarMap.set(String(id), avatar)
    }
    await sleep(300)
  }
  console.log(`  Bulk: ${avatarMap.size}`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// Gate.io
// ══════════════════════════════════════
async function enrichGateio() {
  const source = 'gateio'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  let updated = 0
  for (let i = 0; i < Math.min(traders.length, 500); i++) {
    const t = traders[i]
    const data = await fetchJSON(`https://www.gate.io/api/copytrade/copy_trading/leader/detail?leader_id=${t.source_trader_id}`)
    const avatar = data?.data?.avatar || data?.data?.head_pic
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    if ((i + 1) % 50 === 0) console.log(`  Progress: ${i + 1}/${traders.length}`)
    await sleep(300)
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// LBank
// ══════════════════════════════════════
async function enrichLBank() {
  const source = 'lbank'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  const avatarMap = new Map()
  for (let page = 1; page <= 20; page++) {
    const data = await fetchJSON(`https://www.lbank.com/api/copy-trading/trader/list?page=${page}&pageSize=50`)
    const list = data?.data?.list || data?.data
    if (!Array.isArray(list) || !list.length) break
    for (const t of list) {
      const id = t.uid || t.userId || t.traderId
      const avatar = t.headPhoto || t.avatar || t.avatarUrl
      const nickname = (t.nickname || t.nickName || '').toLowerCase()
      if (id && avatar) avatarMap.set(String(id), avatar)
      if (nickname && avatar) avatarMap.set(nickname, avatar)
    }
    await sleep(300)
  }
  console.log(`  Bulk: ${avatarMap.size}`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get((t.handle || '').toLowerCase())
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// XT
// ══════════════════════════════════════
async function enrichXT() {
  const source = 'xt'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  const avatarMap = new Map()
  // Try XT API
  for (let page = 1; page <= 100; page++) {
    const data = await fetchJSON(`https://www.xt.com/copytrade/api/v1/public/elite-leader-list-v2?page=${page}&pageSize=50`)
    let items = []
    if (Array.isArray(data?.result)) {
      for (const cat of data.result) {
        if (cat.items?.length) items.push(...cat.items)
      }
    }
    if (data?.result?.items) items = data.result.items
    if (!items.length) break
    for (const t of items) {
      const id = String(t.accountId || '')
      const avatar = t.avatar || t.avatarUrl
      if (id && avatar) avatarMap.set(id, avatar)
    }
    await sleep(200)
  }
  console.log(`  Bulk: ${avatarMap.size}`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// Phemex
// ══════════════════════════════════════
async function enrichPhemex() {
  const source = 'phemex'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON(`https://api.phemex.com/copy-trade/public/leader?leaderId=${t.source_trader_id}`)
    const avatar = data?.data?.avatar || data?.data?.headImg
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    await sleep(300)
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// Fill missing profile_url
// ══════════════════════════════════════
async function fillProfileUrls() {
  console.log(`\n🔗 Filling missing profile_url...`)
  let totalUpdated = 0
  for (const [source, urlFn] of Object.entries(PROFILE_URLS)) {
    let from = 0
    let updated = 0
    while (true) {
      const { data } = await supabase.from('trader_sources')
        .select('id, source_trader_id')
        .eq('source', source).is('profile_url', null)
        .range(from, from + 999)
      if (!data?.length) break
      for (const t of data) {
        const url = urlFn(t.source_trader_id)
        await supabase.from('trader_sources').update({ profile_url: url }).eq('id', t.id)
        updated++
      }
      from += 1000
      if (data.length < 1000) break
    }
    if (updated > 0) {
      console.log(`  ${source}: ${updated} profile_urls filled`)
      totalUpdated += updated
    }
  }
  console.log(`  ✅ Total profile_urls filled: ${totalUpdated}`)
}

// ══════════════════════════════════════
// Main
// ══════════════════════════════════════
async function main() {
  console.log('🚀 Avatar Enrichment Script')
  console.log('=' .repeat(50))

  const startCounts = {}
  for (const s of Object.keys(PROFILE_URLS)) {
    const { count } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).eq('source', s).is('avatar_url', null)
    if (count > 0) startCounts[s] = count
  }

  // Run all enrichments
  await enrichBinanceFutures()
  await enrichBinanceSpot()
  await enrichBybit()
  await enrichBitget('bitget_futures')
  await enrichBitget('bitget_spot')
  await enrichOKX()
  await enrichOKXWeb3()
  await enrichMEXC()
  await enrichCoinEx()
  await enrichHTX()
  await enrichKuCoin()
  await enrichWeex()
  await enrichGateio()
  await enrichLBank()
  await enrichXT()
  await enrichPhemex()
  await fillProfileUrls()

  // Summary
  console.log('\n' + '='.repeat(50))
  console.log('📊 SUMMARY')
  console.log('='.repeat(50))
  let totalUpdated = 0
  for (const [source, count] of Object.entries(results)) {
    if (count > 0) {
      console.log(`  ${source.padEnd(20)} +${count} avatars`)
      totalUpdated += count
    }
  }
  console.log(`\n  TOTAL: +${totalUpdated} new avatars`)

  // Final count
  const { count: finalMissing } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).is('avatar_url', null)
  const { count: finalHas } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).not('avatar_url', 'is', null)
  console.log(`\n  Before: ~6103 with avatars`)
  console.log(`  After:  ${finalHas} with avatars (${finalMissing} still missing)`)
  console.log(`  Coverage: ${((finalHas / (finalHas + finalMissing)) * 100).toFixed(1)}%`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
