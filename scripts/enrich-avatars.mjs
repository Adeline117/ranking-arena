#!/usr/bin/env node
/**
 * enrich-avatars.mjs — Avatar enrichment using APIs that work from this machine
 * 
 * Working: HTX ✅, KuCoin ✅ (leaderboard has avatars)
 * Blocked: Binance (451), Bitget (CF), Bybit (404), MEXC (sig), CoinEx (404), XT (HTML), OKX (404)
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = {}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function fetchJSON(url, options = {}) {
  try {
    const resp = await fetch(url, {
      ...options,
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch { return null }
}

async function postJSON(url, body, extra = {}) {
  return fetchJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
}

async function getMissing(source) {
  const all = []
  let from = 0
  while (true) {
    const { data } = await supabase.from('trader_sources').select('id, source_trader_id, handle').eq('source', source).is('avatar_url', null).range(from, from + 999)
    if (!data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  return all
}

async function updateAvatar(id, url) {
  if (!url || url.includes('default') || url.length < 10) return false
  const { error } = await supabase.from('trader_sources').update({ avatar_url: url }).eq('id', id)
  return !error
}

// Profile URL templates
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
  phemex: id => `https://phemex.com/copy-trading/trader/${id}`,
  bingx: id => `https://bingx.com/copy-trading/trader/${id}`,
  blofin: id => `https://blofin.com/copy-trading/trader/${id}`,
  bitmart: id => `https://www.bitmart.com/copy-trading/trader/${id}`,
}

// ══════════════════════════════════════
// HTX Futures — API works perfectly
// ══════════════════════════════════════
async function enrichHTX() {
  const source = 'htx_futures'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  const avatarMap = new Map()
  for (let page = 1; page <= 30; page++) {
    const data = await fetchJSON(`https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=50`)
    if (data?.code !== 200 || !data?.data?.itemList?.length) break
    for (const t of data.data.itemList) {
      if (t.imgUrl) {
        if (t.userSign) avatarMap.set(t.userSign, t.imgUrl)
        if (t.uid) avatarMap.set(String(t.uid), t.imgUrl)
        if (t.nickName) avatarMap.set(t.nickName.toLowerCase(), t.imgUrl)
      }
    }
    if (data.data.itemList.length < 50) break
    await sleep(300)
  }
  // Also try other rank types
  for (const rankType of [2, 3, 4]) {
    for (let page = 1; page <= 10; page++) {
      const data = await fetchJSON(`https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=${rankType}&pageNo=${page}&pageSize=50`)
      if (data?.code !== 200 || !data?.data?.itemList?.length) break
      for (const t of data.data.itemList) {
        if (t.imgUrl) {
          if (t.userSign) avatarMap.set(t.userSign, t.imgUrl)
          if (t.uid) avatarMap.set(String(t.uid), t.imgUrl)
        }
      }
      if (data.data.itemList.length < 50) break
      await sleep(300)
    }
  }
  console.log(`  Collected ${avatarMap.size} avatars from API`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get((t.handle || '').toLowerCase())
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// KuCoin — Leaderboard API works, has avatarUrl
// ══════════════════════════════════════
async function enrichKuCoin() {
  const source = 'kucoin'
  console.log(`\n🔄 ${source}`)
  const traders = await getMissing(source)
  if (!traders.length) { console.log('  0 missing'); return }
  console.log(`  ${traders.length} missing`)

  const avatarMap = new Map()
  for (let page = 1; page <= 135; page++) {
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
    if (page % 20 === 0) console.log(`  Page ${page}: ${avatarMap.size} avatars`)
    await sleep(200)
  }
  console.log(`  Collected ${avatarMap.size} avatars from API`)

  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get((t.handle || '').toLowerCase())
    if (avatar && await updateAvatar(t.id, avatar)) updated++
  }
  results[source] = updated
  console.log(`  ✅ Updated ${updated} avatars for ${source}`)
}

// ══════════════════════════════════════
// Fill missing profile_url for ALL platforms
// ══════════════════════════════════════
async function fillProfileUrls() {
  console.log(`\n🔗 Filling missing profile_url...`)
  let totalUpdated = 0
  for (const [source, urlFn] of Object.entries(PROFILE_URLS)) {
    const batch = []
    let from = 0
    while (true) {
      const { data } = await supabase.from('trader_sources')
        .select('id, source_trader_id')
        .eq('source', source).is('profile_url', null)
        .range(from, from + 999)
      if (!data?.length) break
      batch.push(...data)
      if (data.length < 1000) break
      from += 1000
    }
    if (!batch.length) continue

    // Batch update in chunks of 100
    let updated = 0
    for (let i = 0; i < batch.length; i++) {
      const t = batch[i]
      const url = urlFn(t.source_trader_id)
      const { error } = await supabase.from('trader_sources').update({ profile_url: url }).eq('id', t.id)
      if (!error) updated++
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
  console.log('='.repeat(50))
  console.log('Note: Only HTX and KuCoin APIs work from this machine.')
  console.log('Binance/Bitget/Bybit/MEXC/CoinEx/XT/OKX are geo-blocked or CF-protected.\n')

  // Get initial counts
  const { count: beforeHas } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).not('avatar_url', 'is', null)
  const { count: beforeMissing } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).is('avatar_url', null)
  console.log(`Before: ${beforeHas} with avatars, ${beforeMissing} missing (${((beforeHas/(beforeHas+beforeMissing))*100).toFixed(1)}%)`)

  await enrichHTX()
  await enrichKuCoin()
  await fillProfileUrls()

  // Summary
  console.log('\n' + '='.repeat(50))
  console.log('📊 AVATAR ENRICHMENT SUMMARY')
  console.log('='.repeat(50))
  let totalUpdated = 0
  for (const [source, count] of Object.entries(results)) {
    console.log(`  ${source.padEnd(20)} +${count} avatars`)
    totalUpdated += count
  }
  console.log(`  ${'TOTAL'.padEnd(20)} +${totalUpdated} new avatars`)

  const { count: afterHas } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).not('avatar_url', 'is', null)
  const { count: afterMissing } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).is('avatar_url', null)
  console.log(`\n  After: ${afterHas} with avatars, ${afterMissing} missing (${((afterHas/(afterHas+afterMissing))*100).toFixed(1)}%)`)

  // Breakdown of remaining missing
  console.log('\n  Remaining missing by source:')
  for (const s of ['binance_futures','binance_spot','bybit','bitget_futures','bitget_spot','mexc','coinex','okx_futures','okx_web3','htx_futures','kucoin','weex','xt','lbank','bingx','blofin','phemex','hyperliquid','gmx','dydx','gains','binance_web3']) {
    const { count } = await supabase.from('trader_sources').select('id', { count: 'exact', head: true }).eq('source', s).is('avatar_url', null)
    if (count > 0) console.log(`    ${s.padEnd(20)} ${count}`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
