#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url, options = {}) {
  try {
    const resp = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch { return null }
}

async function getMissingTraders(source) {
  const all = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', source)
      .is('avatar_url', null)
      .range(from, from + 999)
    if (error || !data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  return all
}

async function updateAvatar(id, avatarUrl) {
  const { error } = await supabase
    .from('trader_sources')
    .update({ avatar_url: avatarUrl })
    .eq('id', id)
  return !error
}

const results = {}

// Binance Futures - leaderboard API
async function fetchBinanceFutures() {
  const traders = await getMissingTraders('binance_futures')
  if (!traders.length) return console.log('  binance_futures: 0 missing')
  console.log(`  binance_futures: ${traders.length} missing`)
  
  // Collect avatars from leaderboard pages
  const avatarMap = new Map()
  for (let page = 1; page <= 10; page++) {
    const data = await fetchJSON('https://www.binance.com/bapi/futures/v3/public/future/leaderboard/getLeaderboardRank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
      body: JSON.stringify({ isShared: true, isTrader: false, periodType: 'WEEKLY', statisticsType: 'ROI', tradeType: 'PERPETUAL' }),
    })
    if (data?.data) {
      for (const t of data.data) {
        if (t.encryptedUid && t.userPhotoUrl) avatarMap.set(t.encryptedUid, t.userPhotoUrl)
      }
    }
  }
  // Also try individual detail
  let updated = 0
  for (const t of traders) {
    let avatar = avatarMap.get(t.source_trader_id)
    if (!avatar) {
      const data = await fetchJSON('https://www.binance.com/bapi/futures/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
        body: JSON.stringify({ encryptedUid: t.source_trader_id }),
      })
      avatar = data?.data?.userPhotoUrl
      await sleep(1000)
    }
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results.binance_futures = updated
  console.log(`  binance_futures: ${updated}/${traders.length} updated`)
}

// Binance Spot
async function fetchBinanceSpot() {
  const traders = await getMissingTraders('binance_spot')
  if (!traders.length) return console.log('  binance_spot: 0 missing')
  console.log(`  binance_spot: ${traders.length} missing`)
  
  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON('https://www.binance.com/bapi/futures/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
      body: JSON.stringify({ encryptedUid: t.source_trader_id }),
    })
    const avatar = data?.data?.userPhotoUrl
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    await sleep(1000)
  }
  results.binance_spot = updated
  console.log(`  binance_spot: ${updated}/${traders.length} updated`)
}

// Bitget Futures
async function fetchBitgetFutures() {
  const traders = await getMissingTraders('bitget_futures')
  if (!traders.length) return console.log('  bitget_futures: 0 missing')
  console.log(`  bitget_futures: ${traders.length} missing`)
  
  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON(
      `https://www.bitget.com/v1/copy/mix/trader/detail?traderId=${t.source_trader_id}`,
      { headers: { 'Origin': 'https://www.bitget.com' } },
    )
    const avatar = data?.data?.traderImg || data?.data?.avatar || data?.data?.headUrl
    if (avatar && !avatar.includes('default') && await updateAvatar(t.id, avatar)) updated++
    await sleep(1500)
  }
  results.bitget_futures = updated
  console.log(`  bitget_futures: ${updated}/${traders.length} updated`)
}

// Bitget Spot
async function fetchBitgetSpot() {
  const traders = await getMissingTraders('bitget_spot')
  if (!traders.length) return console.log('  bitget_spot: 0 missing')
  console.log(`  bitget_spot: ${traders.length} missing, fetching...`)
  
  let updated = 0
  for (const t of traders) {
    // Try spot endpoint first, then futures
    for (const ep of ['spot', 'mix']) {
      const data = await fetchJSON(
        `https://www.bitget.com/v1/copy/${ep}/trader/detail?traderId=${t.source_trader_id}`,
        { headers: { 'Origin': 'https://www.bitget.com' } },
      )
      const avatar = data?.data?.traderImg || data?.data?.avatar || data?.data?.headUrl
      if (avatar && !avatar.includes('default')) {
        if (await updateAvatar(t.id, avatar)) updated++
        break
      }
    }
    if (updated % 50 === 0 && updated > 0) console.log(`    ...${updated} so far`)
    await sleep(1500)
  }
  results.bitget_spot = updated
  console.log(`  bitget_spot: ${updated}/${traders.length} updated`)
}

// MEXC
async function fetchMEXC() {
  const traders = await getMissingTraders('mexc')
  if (!traders.length) return console.log('  mexc: 0 missing')
  console.log(`  mexc: ${traders.length} missing`)
  
  // Try leaderboard API
  const avatarMap = new Map()
  for (const period of ['ROI_WEEKLY', 'PNL_WEEKLY', 'ROI_MONTHLY', 'PNL_MONTHLY']) {
    const data = await fetchJSON(`https://futures.mexc.com/api/v1/private/account/copyTrade/rank/list?rankType=${period}&pageNum=1&pageSize=100`)
    if (data?.data?.list) {
      for (const t of data.data.list) {
        const id = String(t.traderId || t.uid || t.id || '')
        const avatar = t.avatar || t.headImg || t.portraitUrl
        if (id && avatar) avatarMap.set(id, avatar)
      }
    }
    await sleep(500)
  }
  
  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  
  // For remaining, try individual
  if (updated < traders.length) {
    for (const t of traders) {
      if (avatarMap.has(t.source_trader_id)) continue
      const data = await fetchJSON(`https://futures.mexc.com/api/v1/private/account/copyTrade/trader/detail?traderId=${t.source_trader_id}`)
      const avatar = data?.data?.avatar || data?.data?.headImg
      if (avatar && await updateAvatar(t.id, avatar)) updated++
      await sleep(1000)
    }
  }
  results.mexc = updated
  console.log(`  mexc: ${updated}/${traders.length} updated`)
}

// CoinEx
async function fetchCoinEx() {
  const traders = await getMissingTraders('coinex')
  if (!traders.length) return console.log('  coinex: 0 missing')
  console.log(`  coinex: ${traders.length} missing`)
  
  const avatarMap = new Map()
  for (let page = 1; page <= 5; page++) {
    const data = await fetchJSON(`https://www.coinex.com/res/copytrading/rank?page=${page}&limit=50&sort_type=profit_rate&period=weekly`)
    const list = data?.data?.data || data?.data?.list || data?.data || []
    if (Array.isArray(list)) {
      for (const t of list) {
        const id = String(t.trader_id || t.traderId || t.uid || '')
        const avatar = t.avatar || t.head_img || t.avatar_url
        if (id && avatar) avatarMap.set(id, avatar)
      }
    }
    await sleep(500)
  }
  
  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results.coinex = updated
  console.log(`  coinex: ${updated}/${traders.length} updated`)
}

// KuCoin
async function fetchKuCoin() {
  const traders = await getMissingTraders('kucoin')
  if (!traders.length) return console.log('  kucoin: 0 missing')
  console.log(`  kucoin: ${traders.length} missing`)
  
  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON(`https://www.kucoin.com/_api/copy-trade/leader/detail?userId=${t.source_trader_id}`)
    const avatar = data?.data?.avatar || data?.data?.photo
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    await sleep(1500)
  }
  results.kucoin = updated
  console.log(`  kucoin: ${updated}/${traders.length} updated`)
}

// Bybit
async function fetchBybit() {
  const traders = await getMissingTraders('bybit')
  if (!traders.length) return console.log('  bybit: 0 missing')
  console.log(`  bybit: ${traders.length} missing`)
  
  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader-detail?leaderId=${t.source_trader_id}`)
    const avatar = data?.result?.avatar || data?.result?.userPhoto
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    await sleep(1000)
  }
  results.bybit = updated
  console.log(`  bybit: ${updated}/${traders.length} updated`)
}

async function main() {
  console.log('=== Fast Avatar Enrichment ===\n')
  
  // Run all platforms
  await fetchBinanceFutures()
  await fetchBinanceSpot()
  await fetchBitgetFutures()
  await fetchBitgetSpot()
  await fetchMEXC()
  await fetchCoinEx()
  await fetchKuCoin()
  await fetchBybit()
  
  console.log('\n=== Results ===')
  let total = 0
  for (const [platform, count] of Object.entries(results)) {
    console.log(`  ${platform}: ${count} avatars added`)
    total += count
  }
  console.log(`  TOTAL: ${total} avatars added`)
  
  // Final coverage
  const { data: allTraders } = await supabase
    .from('trader_sources')
    .select('source, avatar_url')
  
  const stats = {}
  for (const t of (allTraders || [])) {
    if (!stats[t.source]) stats[t.source] = { total: 0, has: 0 }
    stats[t.source].total++
    if (t.avatar_url) stats[t.source].has++
  }
  
  console.log('\n=== Final Coverage ===')
  let grandTotal = 0, grandHas = 0
  for (const [source, s] of Object.entries(stats).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${source.padEnd(20)} ${s.has}/${s.total} (${((s.has/s.total)*100).toFixed(1)}%)`)
    grandTotal += s.total
    grandHas += s.has
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${grandHas}/${grandTotal} (${((grandHas/grandTotal)*100).toFixed(1)}%)`)
}

main().catch(console.error)
