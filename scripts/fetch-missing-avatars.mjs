#!/usr/bin/env node
/**
 * fetch-missing-avatars.mjs
 * 统一补充所有缺失的交易员头像
 *
 * Usage: node scripts/fetch-missing-avatars.mjs [--dry-run] [--source=xxx]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

const sleep = ms => new Promise(r => setTimeout(r, ms))
const randomDelay = (min, max) => min + Math.random() * (max - min)

async function fetchJSON(url, options = {}) {
  try {
    const resp = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

// Get traders with missing avatars for a platform
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

// Update avatar in database
async function updateAvatar(id, avatarUrl) {
  if (DRY_RUN) return true
  const { error } = await supabase
    .from('trader_sources')
    .update({ avatar_url: avatarUrl })
    .eq('id', id)
  return !error
}

// ── Platform Handlers ──────────────────────────────────────

async function fetchHTX() {
  console.log('\n--- HTX Futures ---')
  const traders = await getMissingTraders('htx_futures')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  // Step 1: Bulk fetch from leaderboard (matches userSign or uid)
  const avatarMap = new Map()
  for (let page = 1; page <= 20; page++) {
    const data = await fetchJSON(
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=50`,
    )
    if (data?.code !== 200 || !data?.data?.itemList?.length) break
    for (const item of data.data.itemList) {
      const avatar = item.imgUrl
      if (!avatar) continue
      if (item.userSign) avatarMap.set(item.userSign, avatar)
      if (item.uid) avatarMap.set(String(item.uid), avatar)
      if (item.nickName) avatarMap.set(item.nickName, avatar)
    }
    if (data.data.itemList.length < 50) break
    await sleep(500)
  }
  console.log(`  Leaderboard: ${avatarMap.size} entries`)

  let updated = 0
  const remaining = []
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get(t.handle)
    if (avatar && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    } else {
      remaining.push(t)
    }
  }

  // Step 2: Try individual detail API for unmatched traders
  if (remaining.length > 0) {
    console.log(`  Trying individual detail API for ${remaining.length} remaining...`)
    for (const t of remaining) {
      // HTX detail API accepts userSign
      const data = await fetchJSON(
        `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/leaderInfo?userSign=${encodeURIComponent(t.source_trader_id)}`,
      )
      const avatar = data?.data?.imgUrl || data?.data?.avatar
      if (avatar && !avatar.includes('default') && await updateAvatar(t.id, avatar)) {
        updated++
        console.log(`  [${updated}] ${t.handle || t.source_trader_id} (detail)`)
      }
      await sleep(randomDelay(1000, 2000))
    }
  }

  console.log(`  HTX: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchOKX() {
  console.log('\n--- OKX Futures ---')
  const traders = await getMissingTraders('okx_futures')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  // Step 1: Bulk fetch from leaderboard
  const avatarMap = new Map()
  for (let page = 1; page <= 10; page++) {
    const data = await fetchJSON(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&page=${page}`,
      { headers: { 'Origin': 'https://www.okx.com' } },
    )
    const ranks = data?.data?.[0]?.ranks || []
    if (!ranks.length) break
    for (const t of ranks) {
      if (t.uniqueCode && t.portLink) avatarMap.set(t.uniqueCode, t.portLink)
    }
    await sleep(1000)
  }
  console.log(`  Leaderboard: ${avatarMap.size} entries`)

  let updated = 0
  const remaining = []
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    } else {
      remaining.push(t)
    }
  }

  // Step 2: Try individual detail API
  if (remaining.length > 0) {
    console.log(`  Trying individual detail for ${remaining.length} remaining...`)
    for (const t of remaining) {
      const data = await fetchJSON(
        `https://www.okx.com/api/v5/copytrading/public-lead-traders/detail?uniqueCode=${encodeURIComponent(t.source_trader_id)}`,
        { headers: { 'Origin': 'https://www.okx.com' } },
      )
      const avatar = data?.data?.[0]?.portLink
      if (avatar && await updateAvatar(t.id, avatar)) {
        updated++
        console.log(`  [${updated}] ${t.handle || t.source_trader_id} (detail)`)
      }
      await sleep(randomDelay(1000, 2000))
    }
  }

  console.log(`  OKX: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchBinanceFutures() {
  console.log('\n--- Binance Futures ---')
  const traders = await getMissingTraders('binance_futures')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON('https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
      body: JSON.stringify({ portfolioId: t.source_trader_id }),
    })
    const avatar = data?.data?.userPhotoUrl
    if (avatar && !avatar.includes('default') && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    }
    await sleep(randomDelay(2000, 4000))
  }
  console.log(`  Binance: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchBybit() {
  console.log('\n--- Bybit ---')
  const traders = await getMissingTraders('bybit')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON(
      `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail?leaderMark=${encodeURIComponent(t.source_trader_id)}`,
      { headers: { 'Origin': 'https://www.bybit.com' } },
    )
    const avatar = data?.result?.avatar
    if (avatar && !avatar.includes('default') && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    }
    await sleep(randomDelay(1500, 3000))
  }
  console.log(`  Bybit: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchMEXC() {
  console.log('\n--- MEXC ---')
  const traders = await getMissingTraders('mexc')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON(
      `https://futures.mexc.com/api/platform/copy-trade/trader/detail?traderId=${t.source_trader_id}`,
      { headers: { 'Origin': 'https://futures.mexc.com' } },
    )
    const avatar = data?.data?.avatar
    if (avatar && !avatar.includes('default') && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    }
    await sleep(randomDelay(1500, 3000))
  }
  console.log(`  MEXC: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchKuCoin() {
  console.log('\n--- KuCoin ---')
  const traders = await getMissingTraders('kucoin')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON(
      `https://www.kucoin.com/_api/copy-trade/leader/detail?leaderId=${t.source_trader_id}`,
      { headers: { 'Origin': 'https://www.kucoin.com' } },
    )
    const avatar = data?.data?.avatar
    if (avatar && !avatar.includes('default') && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    }
    await sleep(randomDelay(1500, 3000))
  }
  console.log(`  KuCoin: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchCoinEx() {
  console.log('\n--- CoinEx ---')
  const traders = await getMissingTraders('coinex')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON(
      `https://www.coinex.com/res/copy-trading/trader/${t.source_trader_id}`,
      { headers: { 'Origin': 'https://www.coinex.com' } },
    )
    const avatar = data?.data?.avatar
    if (avatar && !avatar.includes('default') && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    }
    await sleep(randomDelay(1500, 3000))
  }
  console.log(`  CoinEx: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchBitget() {
  console.log('\n--- Bitget Futures ---')
  const traders = await getMissingTraders('bitget_futures')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  let updated = 0
  for (const t of traders) {
    // Bitget uses trader detail API
    const data = await fetchJSON(
      `https://www.bitget.com/v1/copy/mix/trader/detail?traderId=${t.source_trader_id}`,
      { headers: { 'Origin': 'https://www.bitget.com' } },
    )
    const avatar = data?.data?.traderImg || data?.data?.avatar
    if (avatar && !avatar.includes('default') && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    }
    await sleep(randomDelay(2000, 4000))
  }
  console.log(`  Bitget: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchXT() {
  console.log('\n--- XT ---')
  const traders = await getMissingTraders('xt')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  // Try direct API first (no browser needed for ranking endpoints)
  const avatarMap = new Map()

  // Try multiple API endpoints
  for (const sortType of ['INCOME_RATE', 'TOTAL_INCOME', 'WIN_RATE', 'FOLLOWERS']) {
    for (let page = 1; page <= 20; page++) {
      for (const endpoint of [
        `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-ranking?page=${page}&size=50&days=30&sortType=${sortType}`,
        `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-ranking?page=${page}&size=50&days=90&sortType=${sortType}`,
        `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-ranking?page=${page}&size=50&days=7&sortType=${sortType}`,
      ]) {
        const data = await fetchJSON(endpoint, {
          headers: { 'Origin': 'https://www.xt.com', 'Referer': 'https://www.xt.com/en/copy-trading/futures' },
        })
        if (!data) continue

        let items = []
        if (data?.result?.records) items = data.result.records
        else if (data?.result?.items) items = data.result.items
        else if (Array.isArray(data?.result)) {
          for (const cat of data.result) {
            if (cat.items?.length) items.push(...cat.items)
          }
        }

        for (const t of items) {
          const id = String(t.accountId || t.uid || '')
          const avatar = t.avatar || t.avatarUrl || null
          if (id && avatar && !avatar.includes('default')) {
            avatarMap.set(id, avatar)
          }
        }

        if (items.length < 50) break
        await sleep(500)
      }
    }
  }

  console.log(`  API returned ${avatarMap.size} avatars`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) {
      updated++
    }
  }

  if (updated > 0) console.log(`  XT: ${updated}/${traders.length} updated via API`)

  // If still many missing, note that Playwright script is needed
  const remaining = traders.length - updated
  if (remaining > 50) {
    console.log(`  XT: ${remaining} still missing - run 'node scripts/fetch-xt-avatars.mjs' for browser-based fetch`)
  }
  return updated
}

async function fetchWeex() {
  console.log('\n--- Weex ---')
  const traders = await getMissingTraders('weex')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  // Try Weex API endpoints
  const avatarMap = new Map()

  for (const endpoint of [
    'https://www.weex.com/gateway/v1/futures/copy-trade/leaderboard?pageNo=1&pageSize=200',
    'https://ctradeapi.weex.com/v1/futures/copytrading/topTraderListView',
  ]) {
    const data = await fetchJSON(endpoint, {
      headers: { 'Origin': 'https://www.weex.com', 'Referer': 'https://www.weex.com/' },
    })
    if (!data) continue

    const lists = [data?.data?.list, data?.data?.records, data?.data]
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const t of list) {
        const id = String(t.traderUserId || t.traderId || t.uid || t.id || '')
        const avatar = t.headPic || t.avatar || t.headUrl || null
        if (id && avatar && !avatar.includes('default')) {
          avatarMap.set(id, avatar)
        }
      }
    }
    // Also check nested sections
    if (Array.isArray(data?.data)) {
      for (const section of data.data) {
        const sectionList = section.list || section.traders || []
        for (const t of sectionList) {
          const id = String(t.traderUserId || t.traderId || t.uid || t.id || '')
          const avatar = t.headPic || t.avatar || t.headUrl || null
          if (id && avatar && !avatar.includes('default')) {
            avatarMap.set(id, avatar)
          }
        }
      }
    }
  }

  console.log(`  API returned ${avatarMap.size} avatars`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    }
  }
  console.log(`  Weex: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchBingX() {
  console.log('\n--- BingX ---')
  const traders = await getMissingTraders('bingx')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  // Try BingX public API
  const avatarMap = new Map()

  for (const endpoint of [
    'https://bingx.com/api/copy/v1/leaderboard?pageIndex=1&pageSize=200',
    'https://bingx.com/api/copy/public/v1/leaderboard?pageIndex=1&pageSize=200',
  ]) {
    const data = await fetchJSON(endpoint, {
      headers: { 'Origin': 'https://bingx.com', 'Referer': 'https://bingx.com/' },
    })
    if (!data) continue

    const lists = [data?.data?.list, data?.data?.rows, data?.data?.records, data?.data]
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const t of list) {
        const id = String(t.uniqueId || t.uid || t.traderId || t.id || '')
        const avatar = t.headUrl || t.avatar || t.avatarUrl || null
        if (id && avatar && !avatar.includes('default')) {
          avatarMap.set(id, avatar)
        }
      }
    }
  }

  console.log(`  API returned ${avatarMap.size} avatars`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    }
  }
  console.log(`  BingX: ${updated}/${traders.length} updated`)
  return updated
}

async function fetchBlofin() {
  console.log('\n--- Blofin ---')
  const traders = await getMissingTraders('blofin')
  if (!traders.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${traders.length} traders need avatars`)

  // Try Blofin API
  const avatarMap = new Map()

  for (const endpoint of [
    'https://openapi.blofin.com/api/v1/copytrading/public-lead-traders?page=1&pageSize=200',
    'https://www.blofin.com/api/v1/copytrading/leaderboard?page=1&pageSize=200',
  ]) {
    const data = await fetchJSON(endpoint, {
      headers: { 'Origin': 'https://www.blofin.com' },
    })
    if (!data) continue

    const lists = [data?.data?.list, data?.data?.records, data?.data]
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const t of list) {
        const id = String(t.uniqueName || t.traderId || t.uid || t.id || '')
        const avatar = t.avatar || t.avatarUrl || t.portraitLink || null
        if (id && avatar && !avatar.includes('default')) {
          avatarMap.set(id, avatar)
        }
      }
    }
  }

  console.log(`  API returned ${avatarMap.size} avatars`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await updateAvatar(t.id, avatar)) {
      updated++
      console.log(`  [${updated}] ${t.handle || t.source_trader_id}`)
    }
  }
  console.log(`  Blofin: ${updated}/${traders.length} updated`)
  return updated
}

// ── Main ──────────────────────────────────────────

const PLATFORM_HANDLERS = {
  htx_futures: fetchHTX,
  okx_futures: fetchOKX,
  binance_futures: fetchBinanceFutures,
  bybit: fetchBybit,
  mexc: fetchMEXC,
  kucoin: fetchKuCoin,
  coinex: fetchCoinEx,
  bitget_futures: fetchBitget,
  xt: fetchXT,
  weex: fetchWeex,
  bingx: fetchBingX,
  blofin: fetchBlofin,
}

async function main() {
  console.log(`\nFetch Missing Avatars ${DRY_RUN ? '(DRY RUN)' : ''}`)
  console.log(`Platforms: ${SOURCE_FILTER || 'all'}\n`)

  const sources = SOURCE_FILTER
    ? [SOURCE_FILTER]
    : Object.keys(PLATFORM_HANDLERS)

  let totalUpdated = 0

  for (const source of sources) {
    const handler = PLATFORM_HANDLERS[source]
    if (!handler) {
      console.log(`\n--- ${source} --- (no handler, skipping)`)
      continue
    }
    try {
      totalUpdated += await handler()
    } catch (err) {
      console.error(`  Error for ${source}:`, err.message)
    }
  }

  console.log(`\n========================================`)
  console.log(`Total updated: ${totalUpdated}`)
  console.log(`========================================\n`)

  // Show final coverage
  const { data: allTraders } = await supabase
    .from('trader_sources')
    .select('source, avatar_url')

  const stats = {}
  let totalMissing = 0
  for (const t of (allTraders || [])) {
    if (!stats[t.source]) stats[t.source] = { total: 0, missing: 0 }
    stats[t.source].total++
    if (!t.avatar_url) { stats[t.source].missing++; totalMissing++ }
  }

  if (totalMissing > 0) {
    console.log('Remaining missing avatars:')
    for (const [source, s] of Object.entries(stats).sort((a, b) => b[1].missing - a[1].missing)) {
      if (s.missing > 0) console.log(`  ${source}: ${s.missing}/${s.total}`)
    }
  } else {
    console.log('All traders have avatars!')
  }
}

main().catch(console.error)
