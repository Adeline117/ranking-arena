/**
 * Universal enrichment for small/medium CEX platforms
 * Fetches missing fields from each platform's API and updates trader_snapshots
 * 
 * Usage: node scripts/import/enrich_all_small_cex.mjs [platform] [season]
 * Examples:
 *   node scripts/import/enrich_all_small_cex.mjs btcc 90D
 *   node scripts/import/enrich_all_small_cex.mjs all ALL
 */
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const PROXY = 'http://127.0.0.1:7890'

async function fetchJSON(url, opts = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Accept': 'application/json', ...opts.headers },
        method: opts.method || 'GET',
        body: opts.body,
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(5000 * (i + 1)); continue }
      if (!res.ok) { console.log(`  HTTP ${res.status} for ${url.slice(0, 80)}`); return null }
      return await res.json()
    } catch (e) {
      if (i < 2) await sleep(2000)
      else console.log(`  Fetch failed: ${e.message?.slice(0, 60)}`)
    }
  }
  return null
}

// ===================== PLATFORM ENRICHERS =====================

// --- BTCC ---
async function enrichBTCC(season) {
  console.log(`\n=== BTCC ${season} enrichment ===`)
  // BTCC list API returns: totalTraderAtom (trade count/atom), no AUM
  // We need to paginate ALL traders and match by traderId
  
  const { data: snapshots } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, aum, arena_score')
    .eq('source', 'btcc').eq('season_id', season)
  
  if (!snapshots?.length) return { updated: 0, total: 0 }
  console.log(`  ${snapshots.length} snapshots in DB`)
  
  // Fetch all from API
  const allTraders = new Map()
  for (let page = 1; page <= 100; page++) {
    const json = await fetchJSON('https://www.btcc.com/documentary/trader/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://www.btcc.com/en-US/copy-trading', 'Origin': 'https://www.btcc.com' },
      body: JSON.stringify({ pageNum: page, pageSize: 50, sortField: 'overall', sortType: 1 }),
    })
    if (!json?.rows?.length) break
    json.rows.forEach(t => allTraders.set(String(t.traderId), t))
    if (allTraders.size >= (json.total || 9999)) break
    await sleep(300)
  }
  console.log(`  Fetched ${allTraders.size} traders from API`)
  
  // Also try to get trader detail for trade count
  let updated = 0
  for (const snap of snapshots) {
    const t = allTraders.get(snap.source_trader_id)
    if (!t) continue
    
    const updates = {}
    // totalTraderAtom seems to be total trade volume in USDT, not count
    // But we can try the detail API for trade count
    if (snap.trades_count == null) {
      // Try detail API
      const detail = await fetchJSON(`https://www.btcc.com/documentary/trader/detail?traderId=${snap.source_trader_id}`, {
        headers: { 'Referer': 'https://www.btcc.com/en-US/copy-trading', 'Origin': 'https://www.btcc.com' },
      })
      if (detail?.data?.tradeCount != null) updates.trades_count = parseInt(detail.data.tradeCount)
      else if (detail?.data?.totalOrderCount != null) updates.trades_count = parseInt(detail.data.totalOrderCount)
      else if (detail?.data?.totalTradeNum != null) updates.trades_count = parseInt(detail.data.totalTradeNum)
      await sleep(200)
    }
    if (snap.aum == null && t.totalTraderAtom != null) {
      // Use totalTraderAtom as a proxy for AUM if nothing better
      // Actually, don't - it's trade volume. Skip AUM for BTCC.
    }
    
    if (Object.keys(updates).length > 0) {
      const newRoi = updates.roi ?? snap.roi ?? 0
      const newPnl = updates.pnl ?? snap.pnl
      const newMdd = updates.max_drawdown ?? snap.max_drawdown
      const newWr = updates.win_rate ?? snap.win_rate
      const { totalScore } = calculateArenaScore(newRoi, newPnl, newMdd, newWr, season)
      updates.arena_score = totalScore
      await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
      updated++
    }
  }
  return { updated, total: snapshots.length }
}

// --- XT ---
async function enrichXT(season) {
  console.log(`\n=== XT ${season} enrichment ===`)
  const daysMap = { '7D': 7, '30D': 30, '90D': 90 }
  const days = daysMap[season] || 90
  
  const { data: snapshots } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, aum, arena_score')
    .eq('source', 'xt').eq('season_id', season)
  
  if (!snapshots?.length) return { updated: 0, total: 0 }
  console.log(`  ${snapshots.length} snapshots in DB`)
  
  // Fetch all from API
  const allTraders = new Map()
  for (let page = 1; page <= 20; page++) {
    const json = await fetchJSON(`https://www.xt.com/fapi/user/v1/public/copy-trade/leader-list-v2?pageNo=${page}&pageSize=50&days=${days}`)
    if (!json?.result?.items?.length) break
    json.result.items.forEach(t => allTraders.set(String(t.accountId), t))
    if (!json.result.hasNext) break
    await sleep(300)
  }
  // Also try elite list
  const elite = await fetchJSON(`https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?size=50&days=${days}`)
  if (elite?.result?.items) elite.result.items.forEach(t => allTraders.set(String(t.accountId), t))
  
  console.log(`  Fetched ${allTraders.size} traders from API`)
  
  let updated = 0
  for (const snap of snapshots) {
    const t = allTraders.get(snap.source_trader_id)
    if (!t) continue
    
    const updates = {}
    if (snap.trades_count == null && t.tradeNum != null) updates.trades_count = parseInt(t.tradeNum)
    if (snap.trades_count == null && t.orderNum != null) updates.trades_count = parseInt(t.orderNum)
    if (snap.aum == null && t.aum != null) updates.aum = parseFloat(t.aum)
    if (snap.aum == null && t.totalAssets != null) updates.aum = parseFloat(t.totalAssets)
    
    if (Object.keys(updates).length > 0) {
      await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
      updated++
    }
  }
  return { updated, total: snapshots.length }
}

// --- MEXC ---
async function enrichMEXC(season) {
  console.log(`\n=== MEXC ${season} enrichment ===`)
  
  // MEXC API v2 seems down (404). Let's try the newer endpoints.
  // First test which API works
  const testUrls = [
    'https://contract.mexc.com/api/v1/copytrading/v2/public/trader/list?pageNum=1&pageSize=5',
    'https://futures.mexc.com/api/v1/copytrading/v2/public/trader/list?pageNum=1&pageSize=5',
    'https://www.mexc.com/api/platform/copytrading/v2/public/trader/list?pageNum=1&pageSize=5',
    'https://contract.mexc.com/api/v1/copytrading/public/trader/list?pageNum=1&pageSize=5',
  ]
  
  let workingBase = null
  for (const url of testUrls) {
    const json = await fetchJSON(url, { headers: { 'Referer': 'https://www.mexc.com/', 'Origin': 'https://www.mexc.com' } })
    if (json?.data?.list?.length || json?.data?.length) {
      workingBase = url.replace(/\?.*/, '')
      console.log(`  Working API: ${workingBase}`)
      break
    }
  }
  
  if (!workingBase) {
    console.log('  ❌ No working MEXC API found, need browser-based approach')
    return await enrichMEXCBrowser(season)
  }
  
  // Paginate
  const allTraders = new Map()
  for (let page = 1; page <= 50; page++) {
    const json = await fetchJSON(`${workingBase}?pageNum=${page}&pageSize=20&sortType=1`, {
      headers: { 'Referer': 'https://www.mexc.com/', 'Origin': 'https://www.mexc.com' },
    })
    const list = json?.data?.list || json?.data || []
    if (!list.length) break
    list.forEach(t => {
      const id = String(t.traderId || t.uid || t.id)
      allTraders.set(id, t)
      // Also map by nickname
      if (t.nickName) allTraders.set(t.nickName, t)
    })
    await sleep(300)
  }
  console.log(`  Fetched ${allTraders.size} traders from API`)
  
  return await updateMEXCSnapshots(season, allTraders)
}

async function enrichMEXCBrowser(season) {
  // Browser-based fallback using Playwright
  console.log('  Using browser-based MEXC enrichment...')
  
  const { data: snapshots } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, aum')
    .eq('source', 'mexc').eq('season_id', season)
    .or('win_rate.is.null,max_drawdown.is.null,pnl.is.null,trades_count.is.null')
  
  if (!snapshots?.length) return { updated: 0, total: 0 }
  console.log(`  ${snapshots.length} snapshots need enrichment`)
  
  // For MEXC with no working API, we'll need browser. Skip for now and report.
  return { updated: 0, total: snapshots.length, note: 'MEXC API down, needs browser' }
}

async function updateMEXCSnapshots(season, allTraders) {
  const { data: snapshots } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, aum')
    .eq('source', 'mexc').eq('season_id', season)
    .or('win_rate.is.null,max_drawdown.is.null,pnl.is.null,trades_count.is.null')
  
  if (!snapshots?.length) return { updated: 0, total: 0 }
  
  let updated = 0
  for (const snap of snapshots) {
    const t = allTraders.get(snap.source_trader_id)
    if (!t) continue
    
    const updates = {}
    if (snap.pnl == null && t.totalProfit != null) updates.pnl = parseFloat(t.totalProfit)
    if (snap.win_rate == null && t.winRatio != null) updates.win_rate = parseFloat(t.winRatio) * 100
    if (snap.max_drawdown == null && t.maxDrawdown != null) updates.max_drawdown = parseFloat(t.maxDrawdown) * 100
    if (snap.trades_count == null && t.tradeCount != null) updates.trades_count = parseInt(t.tradeCount)
    if (snap.aum == null && t.aum != null) updates.aum = parseFloat(t.aum)
    
    if (Object.keys(updates).length > 0) {
      const newRoi = snap.roi ?? 0
      const { totalScore } = calculateArenaScore(newRoi, updates.pnl ?? snap.pnl, updates.max_drawdown ?? snap.max_drawdown, updates.win_rate ?? snap.win_rate, season)
      updates.arena_score = totalScore
      await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
      updated++
    }
  }
  return { updated, total: snapshots.length }
}

// --- TOOBIT ---
async function enrichToobit(season) {
  console.log(`\n=== Toobit ${season} enrichment ===`)
  
  const { data: snapshots } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, aum')
    .eq('source', 'toobit').eq('season_id', season)
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
  
  if (!snapshots?.length) return { updated: 0, total: 0 }
  console.log(`  ${snapshots.length} snapshots need enrichment`)
  
  // Try Toobit detail API for each trader
  let updated = 0
  const testUrls = [
    'https://bapi.toobit.com/bapi/v1/copy-trading/trader/detail',
    'https://api.toobit.com/bapi/v1/copy-trading/trader/detail',
    'https://www.toobit.com/bapi/v1/copy-trading/trader/detail',
  ]
  
  // Find working URL
  let detailBase = null
  for (const url of testUrls) {
    const json = await fetchJSON(`${url}?leaderUserId=${snapshots[0].source_trader_id}`, {
      headers: { 'Referer': 'https://www.toobit.com/', 'Origin': 'https://www.toobit.com' }
    })
    if (json?.data || json?.result) { detailBase = url; break }
  }
  
  if (!detailBase) {
    console.log('  ❌ No working Toobit detail API')
    return { updated: 0, total: snapshots.length }
  }
  
  for (const snap of snapshots) {
    const json = await fetchJSON(`${detailBase}?leaderUserId=${snap.source_trader_id}`, {
      headers: { 'Referer': 'https://www.toobit.com/', 'Origin': 'https://www.toobit.com' }
    })
    const d = json?.data || json?.result
    if (!d) { await sleep(300); continue }
    
    const updates = {}
    if (snap.win_rate == null) {
      const wr = d.winRate ?? d.winRatio
      if (wr != null) updates.win_rate = parseFloat(wr) <= 1 ? parseFloat(wr) * 100 : parseFloat(wr)
    }
    if (snap.max_drawdown == null) {
      const mdd = d.maxDrawdown ?? d.maxDrawDown ?? d.mdd
      if (mdd != null) updates.max_drawdown = Math.abs(parseFloat(mdd)) <= 1 ? Math.abs(parseFloat(mdd)) * 100 : Math.abs(parseFloat(mdd))
    }
    if (snap.trades_count == null) {
      const tc = d.tradeCount ?? d.totalTradeNum ?? d.orderCount
      if (tc != null) updates.trades_count = parseInt(tc)
    }
    if (snap.aum == null) {
      const aum = d.aum ?? d.totalAssets ?? d.balance
      if (aum != null) updates.aum = parseFloat(aum)
    }
    
    if (Object.keys(updates).length > 0) {
      const { totalScore } = calculateArenaScore(snap.roi ?? 0, snap.pnl, updates.max_drawdown ?? snap.max_drawdown, updates.win_rate ?? snap.win_rate, season)
      updates.arena_score = totalScore
      await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
      updated++
    }
    await sleep(300)
  }
  return { updated, total: snapshots.length }
}

// --- Generic runner ---
const ENRICHERS = {
  btcc: enrichBTCC,
  xt: enrichXT,
  mexc: enrichMEXC,
  toobit: enrichToobit,
}

async function main() {
  const platform = process.argv[2]?.toLowerCase() || 'all'
  const season = process.argv[3]?.toUpperCase() || 'ALL'
  const seasons = season === 'ALL' ? ['7D', '30D', '90D'] : [season]
  const platforms = platform === 'all' ? Object.keys(ENRICHERS) : [platform]
  
  console.log(`Enriching: ${platforms.join(', ')} for ${seasons.join(', ')}`)
  
  const results = []
  for (const p of platforms) {
    const fn = ENRICHERS[p]
    if (!fn) { console.log(`No enricher for ${p}`); continue }
    for (const s of seasons) {
      const r = await fn(s)
      results.push({ platform: p, season: s, ...r })
      console.log(`  ${p} ${s}: updated=${r.updated}/${r.total} ${r.note || ''}`)
    }
  }
  
  console.log('\n=== Summary ===')
  results.forEach(r => console.log(`  ${r.platform} ${r.season}: ${r.updated}/${r.total} ${r.note || ''}`))
}

main().catch(console.error)
