#!/usr/bin/env node
/**
 * fetch-avatars-comprehensive.mjs
 * 
 * Comprehensive avatar fetching from all accessible exchange APIs.
 * Tests each API before bulk fetching.
 * 
 * Working from US/Mac: HTX ✅, KuCoin ✅, dYdX ✅
 * Usually blocked: Binance, Bitget, Bybit, MEXC, CoinEx, XT, OKX
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function fetchJSON(url, options = {}) {
  try {
    const resp = await fetch(url, {
      ...options,
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return null
    const text = await resp.text()
    try { return JSON.parse(text) } catch { return null }
  } catch { return null }
}

async function postJSON(url, body, extra = {}) {
  return fetchJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
}

async function getMissing(source) {
  const all = []
  let from = 0
  while (true) {
    const { data } = await supabase.from('trader_sources').select('id, source_trader_id, handle')
      .eq('source', source).is('avatar_url', null).range(from, from + 999)
    if (!data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  return all
}

async function updateAvatar(id, url) {
  if (!url || url.includes('default') || url.includes('dicebear') || url.includes('identicon') || url.length < 10) return false
  const { error } = await supabase.from('trader_sources').update({ avatar_url: url }).eq('id', id)
  return !error
}

const results = {}

// ═══ HTX Futures ═══
async function enrichHTX() {
  const source = 'htx_futures'
  const traders = await getMissing(source)
  if (!traders.length) { console.log(`  ${source}: 0 missing ✅`); return }
  console.log(`  ${source}: ${traders.length} missing`)

  const avatarMap = new Map()
  for (const rankType of [1, 2, 3, 4]) {
    for (let page = 1; page <= 30; page++) {
      const data = await fetchJSON(`https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=${rankType}&pageNo=${page}&pageSize=50`)
      if (data?.code !== 200 || !data?.data?.itemList?.length) break
      for (const t of data.data.itemList) {
        if (t.imgUrl) {
          if (t.userSign) avatarMap.set(t.userSign, t.imgUrl)
          if (t.uid) avatarMap.set(String(t.uid), t.imgUrl)
          if (t.nickName) avatarMap.set(t.nickName.toLowerCase(), t.imgUrl)
        }
      }
      if (data.data.itemList.length < 50) break
      await sleep(200)
    }
  }
  console.log(`    Collected ${avatarMap.size} avatars from leaderboard`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get((t.handle || '').toLowerCase())
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`    ✅ ${updated} updated`)
}

// ═══ KuCoin ═══
async function enrichKuCoin() {
  const source = 'kucoin'
  const traders = await getMissing(source)
  if (!traders.length) { console.log(`  ${source}: 0 missing ✅`); return }
  console.log(`  ${source}: ${traders.length} missing`)

  const avatarMap = new Map()
  // Fetch all pages from leaderboard
  for (let page = 1; page <= 200; page++) {
    const data = await postJSON(
      'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US',
      { currentPage: page, pageSize: 20 }
    )
    const list = data?.data?.items
    if (!list?.length) break
    for (const t of list) {
      if (t.leadConfigId && t.avatarUrl) avatarMap.set(String(t.leadConfigId), t.avatarUrl)
      if (t.nickName && t.avatarUrl) avatarMap.set(t.nickName.toLowerCase(), t.avatarUrl)
    }
    if (list.length < 20) break
    if (page % 50 === 0) console.log(`    Page ${page}: ${avatarMap.size} avatars`)
    await sleep(150)
  }
  console.log(`    Collected ${avatarMap.size} avatars from leaderboard`)

  // Try individual detail API for remaining
  let updated = 0
  const traderIdSet = new Set(traders.map(t => t.source_trader_id))
  const remaining = traders.filter(t => !avatarMap.has(t.source_trader_id))
  
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get((t.handle || '').toLowerCase())
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }

  // Individual lookups for unfound ones
  const stillMissing = traders.filter(t => !avatarMap.has(t.source_trader_id) && !avatarMap.has((t.handle || '').toLowerCase()))
  console.log(`    ${stillMissing.length} still missing after leaderboard, trying individual lookups...`)
  
  for (let i = 0; i < Math.min(stillMissing.length, 100); i++) {
    const t = stillMissing[i]
    const data = await postJSON(
      'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/trader/detail?lang=en_US',
      { leadConfigId: t.source_trader_id }
    )
    const avatar = data?.data?.avatarUrl
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    await sleep(300)
    if ((i + 1) % 20 === 0) console.log(`    Individual: ${i + 1}/${Math.min(stillMissing.length, 100)}`)
  }

  results[source] = updated
  console.log(`    ✅ ${updated} updated`)
}

// ═══ Bybit - try leaderboard API ═══
async function enrichBybit() {
  const source = 'bybit'
  const traders = await getMissing(source)
  if (!traders.length) { console.log(`  ${source}: 0 missing ✅`); return }
  console.log(`  ${source}: ${traders.length} missing`)

  // Test API first
  const test = await fetchJSON('https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?timeStamp=0&pageSize=20&page=1')
  if (!test?.result?.leaderList) {
    console.log(`    ❌ Bybit API blocked/unavailable`)
    return
  }

  const avatarMap = new Map()
  for (let page = 1; page <= 50; page++) {
    const data = await fetchJSON(`https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?timeStamp=0&pageSize=20&page=${page}`)
    const list = data?.result?.leaderList
    if (!list?.length) break
    for (const t of list) {
      if (t.leaderMark && t.avatar) avatarMap.set(t.leaderMark, t.avatar)
      if (t.nickName && t.avatar) avatarMap.set(t.nickName.toLowerCase(), t.avatar)
    }
    if (list.length < 20) break
    await sleep(300)
  }
  console.log(`    Collected ${avatarMap.size} avatars`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get((t.handle || '').toLowerCase())
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`    ✅ ${updated} updated`)
}

// ═══ dYdX v4 ═══
async function enrichDydx() {
  const source = 'dydx'
  const traders = await getMissing(source)
  if (!traders.length) { console.log(`  ${source}: 0 missing ✅`); return }
  console.log(`  ${source}: ${traders.length} missing`)

  // dYdX leaderboard has profile pictures from Twitter linkage
  let updated = 0
  for (const t of traders) {
    const data = await fetchJSON(`https://indexer.dydx.trade/v4/addresses/${t.source_trader_id}`)
    // dYdX doesn't really have avatars in the indexer
    // Try the affiliates/profile endpoint
    const profile = await fetchJSON(`https://dydx.trade/api/profiles/${t.source_trader_id}`)
    const avatar = profile?.avatarUrl || profile?.avatar || profile?.profileImageUrl
    if (avatar && await updateAvatar(t.id, avatar)) updated++
    await sleep(500)
  }
  results[source] = updated
  console.log(`    ✅ ${updated} updated`)
}

// ═══ ENS Avatars for on-chain addresses ═══
async function enrichENS() {
  console.log(`\n  🔗 ENS reverse lookup for on-chain addresses`)
  const onChainSources = ['hyperliquid', 'gmx', 'gains', 'aevo', 'okx_web3', 'binance_web3', 'jupiter_perps']
  
  let totalChecked = 0, totalFound = 0
  
  for (const source of onChainSources) {
    const traders = await getMissing(source)
    if (!traders.length) continue
    
    // Filter to ETH addresses only (0x...)
    const ethTraders = traders.filter(t => t.source_trader_id?.startsWith('0x'))
    if (!ethTraders.length) continue
    
    console.log(`    ${source}: ${ethTraders.length} ETH addresses to check`)
    
    let found = 0
    // Sample first 200 per source to avoid rate limits
    const sample = ethTraders.slice(0, 200)
    
    for (let i = 0; i < sample.length; i++) {
      const t = sample[i]
      try {
        const data = await fetchJSON(`https://api.ensdata.net/${t.source_trader_id}`)
        if (data && !data.error && data.avatar) {
          if (await updateAvatar(t.id, data.avatar)) {
            found++
            // Also update handle if ENS name found
            if (data.ens_primary && data.ens_primary !== t.handle) {
              await supabase.from('trader_sources').update({ handle: data.ens_primary }).eq('id', t.id)
            }
          }
        }
      } catch {}
      totalChecked++
      if ((i + 1) % 50 === 0) console.log(`      ${i + 1}/${sample.length} checked, ${found} found`)
      await sleep(200) // Rate limit
    }
    
    if (found > 0) {
      results[`${source}_ens`] = found
      totalFound += found
    }
    console.log(`    ${source}: ${found}/${sample.length} ENS avatars found`)
  }
  
  console.log(`    Total ENS: ${totalFound} avatars from ${totalChecked} lookups`)
}

// ═══ MEXC leaderboard ═══
async function enrichMEXC() {
  const source = 'mexc'
  const traders = await getMissing(source)
  if (!traders.length) { console.log(`  ${source}: 0 missing ✅`); return }
  console.log(`  ${source}: ${traders.length} missing`)

  // Test API
  const test = await fetchJSON('https://futures.mexc.com/api/v1/copytrading/traderRank?traderRankType=1&pageNo=1&pageSize=5')
  if (!test) {
    // Try alternative endpoint
    const test2 = await postJSON('https://futures.mexc.com/api/v1/copytrading/traderRank', { traderRankType: 1, pageNo: 1, pageSize: 5 })
    if (!test2) {
      console.log(`    ❌ MEXC API blocked/unavailable`)
      return
    }
  }

  const avatarMap = new Map()
  for (const rankType of [1, 2, 3, 4]) {
    for (let page = 1; page <= 50; page++) {
      const data = await fetchJSON(`https://futures.mexc.com/api/v1/copytrading/traderRank?traderRankType=${rankType}&pageNo=${page}&pageSize=50`)
      const list = data?.data?.resultList || data?.data?.list || data?.data || []
      if (!Array.isArray(list) || !list.length) break
      for (const t of list) {
        const id = String(t.traderId || t.uid || t.userId || '')
        const avatar = t.headImg || t.avatar || t.headPic || t.portraitUrl
        if (id && avatar) avatarMap.set(id, avatar)
        if (t.nickName && avatar) avatarMap.set(t.nickName.toLowerCase(), avatar)
      }
      if (list.length < 50) break
      await sleep(300)
    }
  }
  console.log(`    Collected ${avatarMap.size} avatars from leaderboard`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get((t.handle || '').toLowerCase())
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`    ✅ ${updated} updated`)
}

// ═══ Main ═══
async function main() {
  console.log('🚀 Comprehensive Avatar Fetch')
  console.log('═'.repeat(50))

  // Initial stats
  const { count: hasAvatar } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).not('avatar_url', 'is', null)
  const { count: noAvatar } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).is('avatar_url', null)
  console.log(`\nBefore: ${hasAvatar} with avatars, ${noAvatar} missing (${((hasAvatar/(hasAvatar+noAvatar))*100).toFixed(1)}%)\n`)

  await enrichHTX()
  await enrichKuCoin()
  await enrichBybit()
  await enrichMEXC()
  await enrichDydx()
  await enrichENS()

  // Summary
  console.log('\n' + '═'.repeat(50))
  console.log('📊 RESULTS')
  let total = 0
  for (const [src, count] of Object.entries(results)) {
    if (count > 0) {
      console.log(`  ${src.padEnd(25)} +${count}`)
      total += count
    }
  }
  console.log(`  ${'TOTAL'.padEnd(25)} +${total}`)

  // Final coverage
  const { count: afterHas } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).not('avatar_url', 'is', null)
  const { count: afterMissing } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).is('avatar_url', null)
  console.log(`\nAfter: ${afterHas} with avatars, ${afterMissing} missing (${((afterHas/(afterHas+afterMissing))*100).toFixed(1)}%)`)

  // Breakdown
  console.log('\nCoverage by source:')
  const sources = ['binance_futures','binance_spot','bybit','bybit_spot','bitget_futures','bitget_spot',
    'mexc','coinex','okx_futures','okx_web3','htx_futures','kucoin','weex','xt','lbank',
    'hyperliquid','gmx','gains','aevo','jupiter_perps','dydx','bingx','blofin','phemex','binance_web3']
  for (const s of sources) {
    const { count: t } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).eq('source', s)
    const { count: h } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).eq('source', s).not('avatar_url', 'is', null)
    if (t > 0) console.log(`  ${s.padEnd(20)} ${h}/${t} (${((h/t)*100).toFixed(1)}%)`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
