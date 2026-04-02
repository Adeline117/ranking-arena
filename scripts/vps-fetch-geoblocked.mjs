#!/usr/bin/env node
/**
 * One-shot VPS script: fetch geo-blocked platforms and write to Supabase.
 * Platforms: binance_futures, binance_spot, htx_futures, gateio
 * Run on VPS where these APIs are accessible.
 */

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1) }

function num(v) { if (v == null || v === '') return null; const n = Number(v); return isNaN(n) ? null : n }

async function supabaseUpsert(table, rows, onConflict) {
  if (!rows.length) return 0
  const CHUNK = 200; let total = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    })
    if (!res.ok) throw new Error(`${table} upsert ${res.status}: ${await res.text().catch(()=>'')}`)
    total += chunk.length
  }
  return total
}

function buildRows(normalized, platform, marketType, source, window) {
  const now = new Date().toISOString()
  const v2 = normalized.filter(t => t.trader_key).map(t => {
    const roiCapped = t.roi != null && Math.abs(t.roi) > 100000 ? null : (t.roi ?? null)
    return {
      platform, market_type: marketType, trader_key: t.trader_key, window, as_of_ts: now, updated_at: now,
      roi_pct: roiCapped, pnl_usd: t.pnl ?? null, win_rate: t.win_rate ?? null,
      max_drawdown: t.max_drawdown ?? null, arena_score: t.roi != null ? 0 : null,
      sharpe_ratio: t.sharpe_ratio ?? null, trades_count: null, followers: t.followers ?? null, copiers: t.copiers ?? null,
      metrics: { roi: t.roi, pnl: t.pnl, win_rate: t.win_rate, max_drawdown: t.max_drawdown,
        sharpe_ratio: t.sharpe_ratio, followers: t.followers, copiers: t.copiers, aum: t.aum ?? null },
    }
  })
  const v1 = normalized.filter(t => t.trader_key).map(t => ({
    source, source_trader_id: t.trader_key, season_id: window, rank: null,
    roi: t.roi ?? null, pnl: t.pnl ?? null, followers: t.followers ?? null,
    win_rate: t.win_rate ?? null, max_drawdown: t.max_drawdown ?? null,
    trades_count: null, arena_score: null, captured_at: now,
  }))
  return { v2, v1 }
}

async function writeToSupabase(normalized, platform, marketType, source, window) {
  const { v2, v1 } = buildRows(normalized, platform, marketType, source, window)
  const c2 = await supabaseUpsert('trader_snapshots_v2', v2, 'platform,market_type,trader_key,window,as_of_ts')
  const c1 = await supabaseUpsert('trader_snapshots', v1, 'source,source_trader_id,season_id')
  return { v2: c2, v1: c1 }
}

// ── Binance Futures ──
async function fetchBinanceFutures() {
  console.log('--- binance_futures ---')
  const windows = { '7D': '7D', '30D': '30D', '90D': '90D' }
  let totalAll = 0
  for (const [period, window] of Object.entries(windows)) {
    const all = []
    for (let page = 1; page <= 25; page++) { // max 500 traders (20*25)
      const res = await fetch('https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com', 'Referer': 'https://www.binance.com/en/copy-trading' },
        body: JSON.stringify({ pageNumber: page, pageSize: 20, timeRange: period, dataType: 'ROI', favoriteOnly: false, hideFull: false, nickname: '', order: 'DESC', userAsset: 0, portfolioType: 'ALL', useAiRecommended: false }),
      })
      const json = await res.json()
      const list = json?.data?.list || []
      if (!list.length) break
      for (const r of list) {
        all.push({
          trader_key: String(r.leadPortfolioId || r.encryptedUid || ''),
          display_name: r.nickname, roi: num(r.roi), pnl: num(r.pnl),
          win_rate: num(r.winRate), max_drawdown: num(r.mdd),
          followers: num(r.currentCopyCount), copiers: num(r.currentCopyCount),
          aum: num(r.aum), sharpe_ratio: num(r.sharpRatio),
        })
      }
      if (list.length < 20) break
      await new Promise(r => setTimeout(r, 500))
    }
    console.log(`  ${window}: ${all.length} traders`)
    if (all.length) {
      const c = await writeToSupabase(all, 'binance', 'futures', 'binance_futures', window)
      console.log(`  -> v2: ${c.v2}, v1: ${c.v1}`)
      totalAll += all.length
    }
  }
  return totalAll
}

// ── Binance Spot ──
async function fetchBinanceSpot() {
  console.log('--- binance_spot ---')
  const windows = { '7D': '7D', '30D': '30D', '90D': '90D' }
  let totalAll = 0
  for (const [period, window] of Object.entries(windows)) {
    const all = []
    for (let page = 1; page <= 50; page++) {
      const res = await fetch('https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com', 'Referer': 'https://www.binance.com/en/copy-trading/spot' },
        body: JSON.stringify({ pageNumber: page, pageSize: 20, timeRange: period, dataType: 'ROI', favoriteOnly: false, hideFull: false, nickname: '', order: 'DESC', portfolioType: 'ALL' }),
      })
      const json = await res.json()
      const list = json?.data?.list || []
      if (!list.length) break
      for (const r of list) {
        all.push({
          trader_key: String(r.leadPortfolioId || ''),
          display_name: r.nickname, roi: num(r.roi), pnl: num(r.pnl),
          win_rate: num(r.winRate), max_drawdown: num(r.mdd),
          followers: num(r.followers), copiers: num(r.currentCopyCount),
          aum: num(r.aum), sharpe_ratio: num(r.sharpRatio),
        })
      }
      if (list.length < 20) break
      await new Promise(r => setTimeout(r, 500))
    }
    console.log(`  ${window}: ${all.length} traders`)
    if (all.length) {
      const c = await writeToSupabase(all, 'binance', 'spot', 'binance_spot', window)
      console.log(`  -> v2: ${c.v2}, v1: ${c.v1}`)
      totalAll += all.length
    }
  }
  return totalAll
}

// ── HTX Futures ──
async function fetchHtxFutures() {
  console.log('--- htx_futures ---')
  const all = []
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=50`)
    const json = await res.json()
    const list = json?.data?.itemList || json?.data?.list || []
    if (!list.length) break
    for (const r of list) {
      // Compute sharpe from profitList if available
      let sharpe = null
      if (Array.isArray(r.profitList) && r.profitList.length > 1) {
        const returns = []
        for (let i = 1; i < r.profitList.length; i++) {
          returns.push(num(r.profitList[i]) - num(r.profitList[i-1]))
        }
        const mean = returns.reduce((a,b) => a+b, 0) / returns.length
        const std = Math.sqrt(returns.reduce((a,b) => a + (b-mean)**2, 0) / returns.length)
        if (std > 0) sharpe = Math.round((mean / std * Math.sqrt(365)) * 100) / 100
      }
      const wr = num(r.winRate)
      const mdd = num(r.mdd)
      all.push({
        trader_key: String(r.uid || ''),
        display_name: r.nickName,
        roi: num(r.profitRate90 || r.totalProfitRate) != null ? num(r.profitRate90 || r.totalProfitRate) * 100 : null,
        pnl: num(r.profit90 || r.cumulativePnl || r.copyProfit),
        win_rate: wr != null && wr <= 1 ? wr * 100 : wr,
        max_drawdown: mdd != null && mdd <= 1 ? mdd * 100 : mdd,
        followers: num(r.copyUserNum),
        sharpe_ratio: sharpe,
      })
    }
    if (list.length < 50) break
    await new Promise(r => setTimeout(r, 300))
  }
  console.log(`  Total: ${all.length} traders`)
  // HTX only returns overall data, write to all 3 windows
  let totalAll = 0
  for (const window of ['7D', '30D', '90D']) {
    if (all.length) {
      const c = await writeToSupabase(all, 'htx', 'futures', 'htx_futures', window)
      console.log(`  ${window} -> v2: ${c.v2}, v1: ${c.v1}`)
      totalAll += all.length
    }
  }
  return totalAll
}

// ── Gate.io ──
async function fetchGateio() {
  console.log('--- gateio ---')
  const all = []
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.gate.io',
    'Referer': 'https://www.gate.io/strategybot',
  }
  for (let page = 1; page <= 15; page++) {
    const res = await fetch(`https://www.gate.com/apiw/v2/copy/leader/list?page=${page}&page_size=50&order_by=profit_rate&cycle=month`, { headers })
    const json = await res.json()
    const list = json?.list || json?.data?.list || json?.items || []
    if (!list.length) break
    for (const r of list) {
      const wr = num(r.win_rate || r.winRate)
      const mdd = num(r.max_drawdown || r.maxDrawdown)
      all.push({
        trader_key: String(r.leader_id || r.user_id || r.uid || r.id || ''),
        display_name: r.user_info?.nickname || r.nickname || r.name,
        roi: num(r.profit_rate) != null ? num(r.profit_rate) * 100 : null, // ratio -> pct
        pnl: num(r.pnl || r.profit || r.totalPnl),
        win_rate: wr != null && wr <= 1 ? wr * 100 : wr,
        max_drawdown: mdd != null && mdd <= 1 ? mdd * 100 : mdd,
        followers: num(r.curr_follow_num || r.follower_num),
        copiers: num(r.copier_num),
        sharpe_ratio: num(r.sharp_ratio || r.sharpRatio),
      })
    }
    if (list.length < 50) break
    await new Promise(r => setTimeout(r, 300))
  }
  console.log(`  Total: ${all.length} traders (cycle=month, same for all windows)`)
  let totalAll = 0
  for (const window of ['7D', '30D', '90D']) {
    if (all.length) {
      const c = await writeToSupabase(all, 'gateio', 'futures', 'gateio', window)
      console.log(`  ${window} -> v2: ${c.v2}, v1: ${c.v1}`)
      totalAll += all.length
    }
  }
  return totalAll
}

// ── Main ──
async function main() {
  console.log(`[${new Date().toISOString()}] === Geo-blocked Fetch Start ===`)
  const results = {}
  for (const [name, fn] of [['binance_futures', fetchBinanceFutures], ['binance_spot', fetchBinanceSpot], ['htx_futures', fetchHtxFutures], ['gateio', fetchGateio]]) {
    try {
      results[name] = await fn()
    } catch (e) {
      console.error(`${name} FAILED:`, e.message)
      results[name] = 'FAILED: ' + e.message
    }
  }
  console.log(`\n[${new Date().toISOString()}] === Done ===`)
  console.log(JSON.stringify(results, null, 2))
}

main()
