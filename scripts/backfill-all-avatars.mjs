#!/usr/bin/env node
/**
 * backfill-all-avatars.mjs — Comprehensive avatar backfill for ALL platforms
 * 
 * Handles:
 * - CEX platforms (API-based): binance, bybit, bitget, mexc, kucoin, okx, htx, coinex, bingx, blofin, phemex, weex, xt, lbank
 * - DeFi protocols (wallet-based): hyperliquid, gmx, aevo, gains, dydx, jupiter_perps
 *   → Uses Effigy.im for ETH addresses, DiceBear for others
 * 
 * Usage: node scripts/backfill-all-avatars.mjs [--source=xxx] [--dry-run] [--proxy]
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const USE_PROXY = process.argv.includes('--proxy')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const PROXY_URL = 'http://127.0.0.1:7890'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url, options = {}) {
  try {
    const fetchOpts = {
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(15000),
    }
    const resp = await fetch(url, fetchOpts)
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

async function batchUpdate(updates) {
  if (DRY_RUN || !updates.length) return updates.length
  let ok = 0
  // Parallel batches of 20 concurrent updates
  const CONCURRENCY = 20
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const batch = updates.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(({ id, avatar_url }) =>
        supabase.from('trader_sources').update({ avatar_url }).eq('id', id)
      )
    )
    ok += results.filter(r => r.status === 'fulfilled' && !r.value.error).length
    if (i % 200 === 0 && i > 0) process.stdout.write(`  ...${i}/${updates.length}\n`)
  }
  return ok
}

const results = {}

// ══════════════════════════════════════════════════
// CEX Platforms
// ══════════════════════════════════════════════════

async function fetchBinanceFutures() {
  const traders = await getMissingTraders('binance_futures')
  if (!traders.length) return log('binance_futures', 0, 0)
  log('binance_futures', traders.length)

  const updates = []
  for (const t of traders) {
    const data = await fetchJSON('https://www.binance.com/bapi/futures/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
      body: JSON.stringify({ encryptedUid: t.source_trader_id }),
    })
    const avatar = data?.data?.userPhotoUrl
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1500)
  }
  const ok = await batchUpdate(updates)
  log('binance_futures', traders.length, ok)
}

async function fetchBinanceSpot() {
  const traders = await getMissingTraders('binance_spot')
  if (!traders.length) return log('binance_spot', 0, 0)
  log('binance_spot', traders.length)

  const updates = []
  for (const t of traders) {
    const data = await fetchJSON('https://www.binance.com/bapi/futures/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
      body: JSON.stringify({ encryptedUid: t.source_trader_id }),
    })
    const avatar = data?.data?.userPhotoUrl
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1500)
  }
  const ok = await batchUpdate(updates)
  log('binance_spot', traders.length, ok)
}

async function fetchBinanceWeb3() {
  // Binance Web3 wallets - use Effigy for ETH addresses
  const traders = await getMissingTraders('binance_web3')
  if (!traders.length) return log('binance_web3', 0, 0)
  log('binance_web3', traders.length)

  const updates = []
  for (const t of traders) {
    const addr = t.source_trader_id
    if (addr?.startsWith('0x')) {
      updates.push({ id: t.id, avatar_url: `https://effigy.im/a/${addr}.svg` })
    } else {
      updates.push({ id: t.id, avatar_url: `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(addr)}` })
    }
  }
  const ok = await batchUpdate(updates)
  log('binance_web3', traders.length, ok)
}

async function fetchBybit() {
  const traders = await getMissingTraders('bybit')
  if (!traders.length) return log('bybit', 0, 0)
  log('bybit', traders.length)

  const updates = []
  for (const t of traders) {
    const data = await fetchJSON(
      `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail?leaderMark=${encodeURIComponent(t.source_trader_id)}`,
      { headers: { 'Origin': 'https://www.bybit.com' } },
    )
    const avatar = data?.result?.avatar
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1200)
  }
  const ok = await batchUpdate(updates)
  log('bybit', traders.length, ok)
}

async function fetchBitgetFutures() {
  const traders = await getMissingTraders('bitget_futures')
  if (!traders.length) return log('bitget_futures', 0, 0)
  log('bitget_futures', traders.length)

  const updates = []
  for (const t of traders) {
    const data = await fetchJSON(
      `https://www.bitget.com/v1/copy/mix/trader/detail?traderId=${t.source_trader_id}`,
      { headers: { 'Origin': 'https://www.bitget.com' } },
    )
    const avatar = data?.data?.traderImg || data?.data?.avatar || data?.data?.headUrl
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1500)
  }
  const ok = await batchUpdate(updates)
  log('bitget_futures', traders.length, ok)
}

async function fetchBitgetSpot() {
  const traders = await getMissingTraders('bitget_spot')
  if (!traders.length) return log('bitget_spot', 0, 0)
  log('bitget_spot', traders.length)

  const updates = []
  for (const t of traders) {
    for (const ep of ['spot', 'mix']) {
      const data = await fetchJSON(
        `https://www.bitget.com/v1/copy/${ep}/trader/detail?traderId=${t.source_trader_id}`,
        { headers: { 'Origin': 'https://www.bitget.com' } },
      )
      const avatar = data?.data?.traderImg || data?.data?.avatar || data?.data?.headUrl
      if (avatar && !avatar.includes('default')) {
        updates.push({ id: t.id, avatar_url: avatar })
        break
      }
    }
    await sleep(1500)
  }
  const ok = await batchUpdate(updates)
  log('bitget_spot', traders.length, ok)
}

async function fetchMEXC() {
  const traders = await getMissingTraders('mexc')
  if (!traders.length) return log('mexc', 0, 0)
  log('mexc', traders.length)

  const updates = []
  for (const t of traders) {
    const data = await fetchJSON(
      `https://futures.mexc.com/api/platform/copy-trade/trader/detail?traderId=${t.source_trader_id}`,
      { headers: { 'Origin': 'https://futures.mexc.com' } },
    )
    const avatar = data?.data?.avatar
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1200)
  }
  const ok = await batchUpdate(updates)
  log('mexc', traders.length, ok)
}

async function fetchOKXFutures() {
  const traders = await getMissingTraders('okx_futures')
  if (!traders.length) return log('okx_futures', 0, 0)
  log('okx_futures', traders.length)

  const updates = []
  for (const t of traders) {
    const data = await fetchJSON(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders/detail?uniqueCode=${encodeURIComponent(t.source_trader_id)}`,
      { headers: { 'Origin': 'https://www.okx.com' } },
    )
    const avatar = data?.data?.[0]?.portLink
    if (avatar) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1500)
  }
  const ok = await batchUpdate(updates)
  log('okx_futures', traders.length, ok)
}

async function fetchOKXWeb3() {
  // OKX Web3 wallets - use Effigy
  const traders = await getMissingTraders('okx_web3')
  if (!traders.length) return log('okx_web3', 0, 0)
  log('okx_web3', traders.length)

  const updates = traders.map(t => ({
    id: t.id,
    avatar_url: t.source_trader_id?.startsWith('0x')
      ? `https://effigy.im/a/${t.source_trader_id}.svg`
      : `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(t.source_trader_id)}`
  }))
  const ok = await batchUpdate(updates)
  log('okx_web3', traders.length, ok)
}

async function fetchHTXFutures() {
  const traders = await getMissingTraders('htx_futures')
  if (!traders.length) return log('htx_futures', 0, 0)
  log('htx_futures', traders.length)

  const updates = []
  for (const t of traders) {
    const data = await fetchJSON(
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/leaderInfo?userSign=${encodeURIComponent(t.source_trader_id)}`,
    )
    const avatar = data?.data?.imgUrl || data?.data?.avatar
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1500)
  }
  const ok = await batchUpdate(updates)
  log('htx_futures', traders.length, ok)
}

async function fetchKuCoin() {
  const traders = await getMissingTraders('kucoin')
  if (!traders.length) return log('kucoin', 0, 0)
  log('kucoin', traders.length)

  const updates = []
  for (const t of traders) {
    const data = await fetchJSON(
      `https://www.kucoin.com/_api/copy-trade/leader/detail?userId=${t.source_trader_id}`,
      { headers: { 'Origin': 'https://www.kucoin.com' } },
    )
    const avatar = data?.data?.avatar || data?.data?.photo
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1500)
  }
  const ok = await batchUpdate(updates)
  log('kucoin', traders.length, ok)
}

async function fetchCoinEx() {
  const traders = await getMissingTraders('coinex')
  if (!traders.length) return log('coinex', 0, 0)
  log('coinex', traders.length)

  const updates = []
  for (const t of traders) {
    const data = await fetchJSON(
      `https://www.coinex.com/res/copy-trading/trader/${t.source_trader_id}`,
      { headers: { 'Origin': 'https://www.coinex.com' } },
    )
    const avatar = data?.data?.avatar
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1500)
  }
  const ok = await batchUpdate(updates)
  log('coinex', traders.length, ok)
}

async function fetchBingX() {
  const traders = await getMissingTraders('bingx')
  if (!traders.length) return log('bingx', 0, 0)
  log('bingx', traders.length)

  // Try leaderboard bulk first
  const avatarMap = new Map()
  for (const endpoint of [
    'https://bingx.com/api/copy/v1/leaderboard?pageIndex=1&pageSize=200',
    'https://bingx.com/api/copy/public/v1/leaderboard?pageIndex=1&pageSize=200',
  ]) {
    const data = await fetchJSON(endpoint, { headers: { 'Origin': 'https://bingx.com' } })
    if (!data) continue
    for (const list of [data?.data?.list, data?.data?.rows, data?.data]) {
      if (!Array.isArray(list)) continue
      for (const t of list) {
        const id = String(t.uniqueId || t.uid || t.traderId || '')
        const avatar = t.headUrl || t.avatar || t.avatarUrl
        if (id && avatar) avatarMap.set(id, avatar)
      }
    }
  }

  const updates = []
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
  }
  const ok = await batchUpdate(updates)
  log('bingx', traders.length, ok)
}

async function fetchBlofin() {
  const traders = await getMissingTraders('blofin')
  if (!traders.length) return log('blofin', 0, 0)
  log('blofin', traders.length)

  const avatarMap = new Map()
  for (const endpoint of [
    'https://openapi.blofin.com/api/v1/copytrading/public-lead-traders?page=1&pageSize=200',
    'https://www.blofin.com/api/v1/copytrading/leaderboard?page=1&pageSize=200',
  ]) {
    const data = await fetchJSON(endpoint, { headers: { 'Origin': 'https://www.blofin.com' } })
    if (!data) continue
    for (const list of [data?.data?.list, data?.data?.records, data?.data]) {
      if (!Array.isArray(list)) continue
      for (const t of list) {
        const id = String(t.uniqueName || t.traderId || t.uid || '')
        const avatar = t.avatar || t.avatarUrl || t.portraitLink
        if (id && avatar) avatarMap.set(id, avatar)
      }
    }
  }

  const updates = []
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
  }
  const ok = await batchUpdate(updates)
  log('blofin', traders.length, ok)
}

async function fetchPhemex() {
  const traders = await getMissingTraders('phemex')
  if (!traders.length) return log('phemex', 0, 0)
  log('phemex', traders.length)

  const updates = []
  for (const t of traders) {
    // Phemex source_trader_ids look like numeric portfolio IDs
    const data = await fetchJSON(
      `https://api.phemex.com/phemex-user/users/children/trad/portfolios/${t.source_trader_id}`,
      { headers: { 'Origin': 'https://phemex.com' } },
    )
    const avatar = data?.data?.userAvatar || data?.data?.avatar
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
    await sleep(1500)
  }
  const ok = await batchUpdate(updates)
  log('phemex', traders.length, ok)
}

async function fetchWeex() {
  const traders = await getMissingTraders('weex')
  if (!traders.length) return log('weex', 0, 0)
  log('weex', traders.length)

  const avatarMap = new Map()
  for (const endpoint of [
    'https://www.weex.com/gateway/v1/futures/copy-trade/leaderboard?pageNo=1&pageSize=200',
    'https://ctradeapi.weex.com/v1/futures/copytrading/topTraderListView',
  ]) {
    const data = await fetchJSON(endpoint, { headers: { 'Origin': 'https://www.weex.com' } })
    if (!data) continue
    for (const list of [data?.data?.list, data?.data?.records, data?.data]) {
      if (!Array.isArray(list)) continue
      for (const t of list) {
        const id = String(t.traderUserId || t.traderId || t.uid || t.id || '')
        const avatar = t.headPic || t.avatar || t.headUrl
        if (id && avatar) avatarMap.set(id, avatar)
      }
    }
  }

  const updates = []
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
  }
  const ok = await batchUpdate(updates)
  log('weex', traders.length, ok)
}

async function fetchXT() {
  const traders = await getMissingTraders('xt')
  if (!traders.length) return log('xt', 0, 0)
  log('xt', traders.length)

  const avatarMap = new Map()
  for (const sortType of ['INCOME_RATE', 'TOTAL_INCOME', 'WIN_RATE', 'FOLLOWERS']) {
    for (const days of [7, 30, 90]) {
      for (let page = 1; page <= 20; page++) {
        const data = await fetchJSON(
          `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-ranking?page=${page}&size=50&days=${days}&sortType=${sortType}`,
          { headers: { 'Origin': 'https://www.xt.com', 'Referer': 'https://www.xt.com/en/copy-trading/futures' } },
        )
        let items = data?.result?.records || data?.result?.items || []
        if (Array.isArray(data?.result)) {
          items = []
          for (const cat of data.result) {
            if (cat.items?.length) items.push(...cat.items)
          }
        }
        for (const t of items) {
          const id = String(t.accountId || t.uid || '')
          const avatar = t.avatar || t.avatarUrl
          if (id && avatar && !avatar.includes('default')) avatarMap.set(id, avatar)
        }
        if (items.length < 50) break
        await sleep(300)
      }
    }
  }

  console.log(`  XT API returned ${avatarMap.size} avatars`)
  const updates = []
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar) updates.push({ id: t.id, avatar_url: avatar })
  }
  const ok = await batchUpdate(updates)
  log('xt', traders.length, ok)
}

async function fetchLBank() {
  const traders = await getMissingTraders('lbank')
  if (!traders.length) return log('lbank', 0, 0)
  log('lbank', traders.length)

  // LBank API endpoints
  const avatarMap = new Map()
  for (let page = 1; page <= 10; page++) {
    for (const period of ['weekly', 'monthly', 'total']) {
      const data = await fetchJSON(
        `https://www.lbank.com/api/v1/supplement/copy_trade/trader/list?page=${page}&size=50&period=${period}`,
        { headers: { 'Origin': 'https://www.lbank.com' } },
      )
      const list = data?.data?.list || data?.data?.items || data?.data || []
      if (Array.isArray(list)) {
        for (const t of list) {
          const nick = (t.nickname || t.nickName || t.name || '').toLowerCase()
          const id = String(t.traderId || t.uid || '')
          const avatar = t.headPhoto || t.avatar || t.avatarUrl || t.photo
          if (avatar) {
            if (nick) avatarMap.set(nick, avatar)
            if (id) avatarMap.set(id, avatar)
          }
        }
      }
      await sleep(500)
    }
  }

  console.log(`  LBank API returned ${avatarMap.size} avatars`)
  const updates = []
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get((t.handle || '').toLowerCase())
    if (avatar && !avatar.includes('default')) updates.push({ id: t.id, avatar_url: avatar })
  }
  const ok = await batchUpdate(updates)
  log('lbank', traders.length, ok)
}

// ══════════════════════════════════════════════════
// DeFi Protocols — Wallet-based avatars
// ══════════════════════════════════════════════════

function ethAvatarUrl(address) {
  if (address?.startsWith('0x') && address.length === 42) {
    return `https://effigy.im/a/${address.toLowerCase()}.svg`
  }
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(address)}`
}

async function fetchDefiProtocol(source) {
  const traders = await getMissingTraders(source)
  if (!traders.length) return log(source, 0, 0)
  log(source, traders.length)

  const updates = traders.map(t => ({
    id: t.id,
    avatar_url: ethAvatarUrl(t.source_trader_id),
  }))
  const ok = await batchUpdate(updates)
  log(source, traders.length, ok)
}

// ══════════════════════════════════════════════════
// Aevo — has pseudonyms, use DiceBear with fun style
// ══════════════════════════════════════════════════

async function fetchAevo() {
  const traders = await getMissingTraders('aevo')
  if (!traders.length) return log('aevo', 0, 0)
  log('aevo', traders.length)

  // Aevo uses pseudonyms like "Lace-Mountainous-Pal"
  // Try Aevo API first
  const avatarMap = new Map()
  for (let page = 0; page < 20; page++) {
    const data = await fetchJSON(
      `https://api.aevo.xyz/leaderboard?offset=${page * 50}&limit=50`,
      { headers: { 'Origin': 'https://app.aevo.xyz' } },
    )
    if (!Array.isArray(data) || !data.length) break
    for (const t of data) {
      const username = (t.username || '').toLowerCase()
      const avatar = t.avatar || t.profile_picture
      if (username && avatar) avatarMap.set(username, avatar)
    }
    if (data.length < 50) break
    await sleep(500)
  }

  console.log(`  Aevo API returned ${avatarMap.size} avatars`)

  const updates = []
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id?.toLowerCase())
    if (avatar) {
      updates.push({ id: t.id, avatar_url: avatar })
    } else {
      // Fallback: DiceBear with fun style for pseudonyms
      updates.push({
        id: t.id,
        avatar_url: `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(t.source_trader_id)}`
      })
    }
  }
  const ok = await batchUpdate(updates)
  log('aevo', traders.length, ok)
}

async function fetchJupiterPerps() {
  const traders = await getMissingTraders('jupiter_perps')
  if (!traders.length) return log('jupiter_perps', 0, 0)
  log('jupiter_perps', traders.length)

  // Solana addresses → DiceBear
  const updates = traders.map(t => ({
    id: t.id,
    avatar_url: `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(t.source_trader_id)}`
  }))
  const ok = await batchUpdate(updates)
  log('jupiter_perps', traders.length, ok)
}

// ══════════════════════════════════════════════════
// Logging & Main
// ══════════════════════════════════════════════════

function log(source, total, updated) {
  if (updated === undefined) {
    console.log(`\n🔄 ${source}: ${total} missing`)
    return
  }
  if (total === 0) {
    console.log(`✅ ${source}: no missing avatars`)
  } else {
    console.log(`✅ ${source}: ${updated}/${total} updated ${DRY_RUN ? '(DRY RUN)' : ''}`)
  }
  results[source] = { total, updated }
}

const HANDLERS = {
  // CEX — individual API lookups (slower, more accurate)
  binance_futures: fetchBinanceFutures,
  binance_spot: fetchBinanceSpot,
  binance_web3: fetchBinanceWeb3,
  bybit: fetchBybit,
  bitget_futures: fetchBitgetFutures,
  bitget_spot: fetchBitgetSpot,
  bitget: () => fetchBitgetFutures(), // alias
  mexc: fetchMEXC,
  okx_futures: fetchOKXFutures,
  okx_web3: fetchOKXWeb3,
  htx_futures: fetchHTXFutures,
  kucoin: fetchKuCoin,
  coinex: fetchCoinEx,
  bingx: fetchBingX,
  blofin: fetchBlofin,
  phemex: fetchPhemex,
  weex: fetchWeex,
  xt: fetchXT,
  lbank: fetchLBank,
  // DeFi — wallet-based identicons
  hyperliquid: () => fetchDefiProtocol('hyperliquid'),
  gmx: () => fetchDefiProtocol('gmx'),
  gains: () => fetchDefiProtocol('gains'),
  dydx: () => fetchDefiProtocol('dydx'),
  aevo: fetchAevo,
  jupiter_perps: fetchJupiterPerps,
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  Avatar Backfill ${DRY_RUN ? '(DRY RUN) ' : ''}                   ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)

  const sources = SOURCE_FILTER ? [SOURCE_FILTER] : Object.keys(HANDLERS)

  for (const source of sources) {
    const handler = HANDLERS[source]
    if (!handler) {
      console.log(`⚠️  ${source}: no handler, skipping`)
      continue
    }
    try {
      await handler()
    } catch (err) {
      console.error(`❌ ${source}: ${err.message}`)
    }
  }

  // Summary
  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  Summary                                 ║`)
  console.log(`╚══════════════════════════════════════════╝`)
  let grandTotal = 0, grandUpdated = 0
  for (const [source, { total, updated }] of Object.entries(results)) {
    if (total > 0) {
      const pct = total > 0 ? ((updated / total) * 100).toFixed(1) : '0.0'
      console.log(`  ${source.padEnd(20)} ${String(updated).padStart(5)}/${String(total).padStart(5)} (${pct}%)`)
      grandTotal += total
      grandUpdated += updated
    }
  }
  console.log(`  ${'─'.repeat(42)}`)
  console.log(`  ${'TOTAL'.padEnd(20)} ${String(grandUpdated).padStart(5)}/${String(grandTotal).padStart(5)} (${grandTotal > 0 ? ((grandUpdated / grandTotal) * 100).toFixed(1) : 0}%)`)
}

main().catch(console.error)
