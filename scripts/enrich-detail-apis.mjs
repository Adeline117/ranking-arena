#!/usr/bin/env node
/**
 * 全平台 Detail API 数据充实脚本
 * 
 * 核心原则：Detail API 永远比 List API 有更多数据
 * 对每个交易员调用详情API，获取：
 *   - 完整snapshot指标 (ROI, PnL, win_rate, MDD, sharpe, trades_count)
 *   - 当前持仓 (positions_live)
 *   - 收益曲线 (equity_curve)
 *   - 交易员Profile (profiles_v2)
 * 
 * 用法: 
 *   node scripts/enrich-detail-apis.mjs                    # 全部平台
 *   node scripts/enrich-detail-apis.mjs binance            # 只跑binance
 *   node scripts/enrich-detail-apis.mjs okx --limit=50     # OKX限50个
 *   node scripts/enrich-detail-apis.mjs --fresh-only       # 只充实最近24h新增的
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL
const HTTP_PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:7890'

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Parse CLI args
const args = process.argv.slice(2)
const platformFilter = args.find(a => !a.startsWith('--'))
const limitArg = args.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 500
const freshOnly = args.includes('--fresh-only')

// ============================================
// HTTP helpers
// ============================================

async function fetchJSON(url, opts = {}) {
  const headers = { 'User-Agent': UA, 'Accept': 'application/json', ...opts.headers }
  try {
    const res = await fetch(url, { ...opts, headers, signal: AbortSignal.timeout(15000) })
    if (res.ok) return await res.json()
    // Try CF proxy for 451/403
    if ((res.status === 451 || res.status === 403) && CF_PROXY) {
      const pRes = await fetch(`${CF_PROXY}/proxy?url=${encodeURIComponent(url)}`, {
        ...opts, headers, signal: AbortSignal.timeout(15000)
      })
      if (pRes.ok) return await pRes.json()
    }
    return null
  } catch {
    if (CF_PROXY) {
      try {
        const pRes = await fetch(`${CF_PROXY}/proxy?url=${encodeURIComponent(url)}`, {
          ...opts, headers, signal: AbortSignal.timeout(15000)
        })
        if (pRes.ok) return await pRes.json()
      } catch {}
    }
    return null
  }
}

async function postJSON(url, body, extraHeaders = {}) {
  return fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  })
}

// ============================================
// DB Helpers
// ============================================

async function upsertSnapshot(platform, marketType, traderKey, window, metrics) {
  const now = new Date().toISOString()
  // Use RPC or raw SQL via supabase to handle the trunc_hour function in conflict
  // Workaround: just insert and handle duplicate via .rpc or catch
  const row = {
    platform, market_type: marketType, trader_key: traderKey, window,
    as_of_ts: now,
    metrics: metrics,
    roi_pct: metrics.roi_pct ?? null,
    pnl_usd: metrics.pnl_usd ?? null,
    win_rate: metrics.win_rate ?? null,
    max_drawdown: metrics.max_drawdown ?? null,
    trades_count: metrics.trades_count ?? null,
    followers: metrics.followers ?? null,
    copiers: metrics.copiers ?? null,
    sharpe_ratio: metrics.sharpe_ratio ?? null,
    quality_flags: {},
    provenance: { source: 'enrich-detail-apis', fetched_at: now },
    updated_at: now,
  }
  
  // First try to find existing row for this hour
  const hourStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString()
  const hourEnd = new Date(Math.floor(Date.now() / 3600000) * 3600000 + 3600000).toISOString()
  
  const { data: existing } = await supabase.from('trader_snapshots_v2')
    .select('id')
    .eq('platform', platform)
    .eq('market_type', marketType)
    .eq('trader_key', traderKey)
    .eq('window', window)
    .gte('as_of_ts', hourStart)
    .lt('as_of_ts', hourEnd)
    .limit(1)
  
  if (existing?.length) {
    // Update existing
    const { error } = await supabase.from('trader_snapshots_v2')
      .update(row).eq('id', existing[0].id)
    if (error) console.error(`  snapshot update error: ${error.message}`)
    return !error
  } else {
    // Insert new
    const { error } = await supabase.from('trader_snapshots_v2').insert(row)
    if (error && !error.message.includes('duplicate')) {
      console.error(`  snapshot insert error: ${error.message}`)
    }
    return !error
  }
}

async function upsertProfile(platform, marketType, traderKey, profile) {
  const now = new Date().toISOString()
  const { error } = await supabase.from('trader_profiles_v2').upsert({
    platform, market_type: marketType, trader_key: traderKey,
    display_name: profile.display_name ?? null,
    avatar_url: profile.avatar_url ?? null,
    bio: profile.bio ?? null,
    tags: profile.tags ?? [],
    profile_url: profile.profile_url ?? null,
    followers: profile.followers ?? null,
    copiers: profile.copiers ?? null,
    aum: profile.aum ?? null,
    provenance: { source: 'enrich-detail-apis', fetched_at: now },
    updated_at: now,
    last_enriched_at: now,
  }, { onConflict: 'platform,market_type,trader_key' })
  if (error && !error.message.includes('duplicate')) console.error(`  profile upsert error: ${error.message}`)
}

async function upsertPositions(platform, traderKey, positions) {
  if (!positions?.length) return
  // Delete old positions for this trader first
  await supabase.from('trader_positions_live')
    .delete()
    .eq('platform', platform)
    .eq('trader_key', traderKey)
  
  for (const pos of positions) {
    const { error } = await supabase.from('trader_positions_live').upsert({
      platform, market_type: 'futures', trader_key: traderKey,
      symbol: pos.symbol,
      side: pos.side,
      entry_price: pos.entry_price || 0.01,
      current_price: pos.current_price ?? null,
      mark_price: pos.mark_price ?? null,
      quantity: pos.quantity ?? 0,
      leverage: pos.leverage ?? null,
      margin: pos.margin ?? null,
      unrealized_pnl: pos.unrealized_pnl ?? null,
      unrealized_pnl_pct: pos.unrealized_pnl_pct ?? null,
      liquidation_price: pos.liquidation_price ?? null,
      opened_at: pos.opened_at ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'platform,trader_key,symbol,side' })
    if (error) console.error(`  position upsert error: ${error.message}`)
  }
}

async function upsertEquityCurve(source, traderKey, period, dataPoints) {
  if (!dataPoints?.length) return
  const now = new Date().toISOString()
  const rows = dataPoints.map(p => ({
    source, source_trader_id: traderKey, period,
    data_date: p.date,
    roi_pct: p.roi_pct ?? null,
    pnl_usd: p.pnl_usd ?? null,
    captured_at: now,
  }))
  // Batch upsert in chunks of 100
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    const { error } = await supabase.from('trader_equity_curve').upsert(chunk, {
      onConflict: 'source,source_trader_id,period,data_date'
    })
    if (error) console.error(`  equity curve upsert error: ${error.message}`)
  }
}

// ============================================
// Get traders to enrich from existing data
// ============================================

async function getTradersToEnrich(source, limit) {
  let query = supabase.from('trader_snapshots')
    .select('source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, aum, sharpe_ratio')
    .eq('source', source)
  
  if (freshOnly) {
    const since = new Date(Date.now() - 24 * 3600000).toISOString()
    query = query.gte('captured_at', since)
  }
  
  const { data, error } = await query.order('captured_at', { ascending: false }).limit(limit * 3)
  if (error) { console.error(`  DB error: ${error.message}`); return [] }
  
  // Deduplicate by source_trader_id
  const seen = new Set()
  const unique = []
  for (const t of (data || [])) {
    if (!t.source_trader_id || seen.has(t.source_trader_id)) continue
    seen.add(t.source_trader_id)
    unique.push(t)
  }
  
  // Also get display names from traders table
  const ids = unique.map(t => t.source_trader_id)
  const { data: traders } = await supabase.from('traders')
    .select('source_trader_id, handle, bio')
    .eq('source', source)
    .in('source_trader_id', ids.slice(0, 100))
  
  const traderMap = new Map()
  for (const tr of (traders || [])) {
    traderMap.set(tr.source_trader_id, tr)
  }
  
  return unique.slice(0, limit).map(t => ({
    ...t,
    nickname: traderMap.get(t.source_trader_id)?.handle || null,
    avatar_url: null,
  }))
}

// ============================================
// BINANCE FUTURES enrichment
// ============================================
async function enrichBinanceFutures() {
  console.log('\n🟡 Binance Futures - Detail API enrichment')
  const traders = await getTradersToEnrich('binance_futures', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  const BASE = 'https://www.binance.com'
  const HEADERS = {
    'Origin': BASE, 'Referer': `${BASE}/en/copy-trading`,
    'Content-Type': 'application/json'
  }
  
  let enriched = 0
  for (const t of traders) {
    try {
      const portfolioId = t.source_trader_id
      
      // 1. Profile detail
      const profile = await postJSON(`${BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail`, 
        { portfolioId }, HEADERS)
      
      // 2. Performance (30D)
      const perf = await postJSON(`${BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance`,
        { portfolioId, timeRange: 'MONTHLY' }, HEADERS)
      
      // 3. Current positions
      const positions = await postJSON(`${BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/current-position`,
        { portfolioId }, HEADERS)
      
      // 4. Equity curve
      const chart = await postJSON(`${BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance-chart`,
        { portfolioId, timeRange: 'ALL' }, HEADERS)
      
      // Extract metrics from performance data
      const pd = perf?.data || {}
      const metrics = {
        roi_pct: parseFloat(pd.roi ?? pd.currentRoi ?? t.roi ?? 0) * (Math.abs(pd.roi ?? 0) < 5 ? 100 : 1),
        pnl_usd: parseFloat(pd.pnl ?? t.pnl ?? 0),
        win_rate: parseFloat(pd.winRate ?? t.win_rate ?? 0) * (parseFloat(pd.winRate ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(pd.maxDrawdown ?? pd.mdd ?? t.max_drawdown ?? 0) * (Math.abs(pd.maxDrawdown ?? 0) <= 1 ? 100 : 1),
        trades_count: parseInt(pd.tradeCount ?? pd.totalTradeCount ?? t.trades_count ?? 0) || null,
        sharpe_ratio: parseFloat(pd.sharpeRatio ?? 0) || null,
        followers: parseInt(pd.followerCount ?? pd.copierCount ?? 0) || null,
        copiers: parseInt(pd.copierCount ?? 0) || null,
        aum: parseFloat(pd.totalMarginBalance ?? pd.aum ?? 0) || null,
      }
      
      // Upsert snapshot
      if (metrics.roi_pct) {
        await upsertSnapshot('binance', 'futures', portfolioId, '30d', metrics)
      }
      
      // Upsert profile
      const pData = profile?.data || {}
      await upsertProfile('binance', 'futures', portfolioId, {
        display_name: pData.nickname || t.nickname,
        avatar_url: pData.userPhotoUrl || t.avatar_url,
        bio: pData.introduction || null,
        tags: pData.tags || [],
        profile_url: `${BASE}/en/copy-trading/lead-details/${portfolioId}`,
        followers: metrics.followers,
        copiers: metrics.copiers,
        aum: metrics.aum,
      })
      
      // Upsert positions
      if (positions?.data?.length) {
        const posData = positions.data.map(p => ({
          symbol: p.symbol || 'UNKNOWN',
          side: parseFloat(p.positionAmt ?? 0) >= 0 ? 'long' : 'short',
          entry_price: parseFloat(p.entryPrice ?? 0),
          mark_price: parseFloat(p.markPrice ?? 0),
          quantity: Math.abs(parseFloat(p.positionAmt ?? 0)),
          leverage: parseFloat(p.leverage ?? 1),
          unrealized_pnl: parseFloat(p.unrealizedProfit ?? 0),
          unrealized_pnl_pct: parseFloat(p.unRealizedRoePct ?? 0) * 100,
        }))
        await upsertPositions('binance', portfolioId, posData)
      }
      
      // Upsert equity curve
      if (chart?.data?.chartData?.length) {
        const curves = chart.data.chartData.map(p => ({
          date: new Date(p.timestamp || p.time).toISOString().split('T')[0],
          roi_pct: parseFloat(p.value ?? 0) * 100,
        }))
        await upsertEquityCurve('binance_futures', portfolioId, 'ALL', curves)
      }
      
      enriched++
      if (enriched % 10 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(500)
    } catch (e) {
      // silently continue
    }
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// OKX FUTURES enrichment
// ============================================
async function enrichOKX() {
  console.log('\n🟢 OKX Futures - Detail API enrichment')
  
  // OKX traders use uniqueCode. Get from list API directly.
  const traders = await getTradersToEnrich('okx_futures', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const uniqueCode = t.source_trader_id
      
      // 1. Weekly PnL (equity curve)
      const weeklyPnl = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-weekly-pnl?instType=SWAP&uniqueCode=${uniqueCode}`)
      
      // 2. Current positions
      const currentPos = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-current-subpositions?instType=SWAP&uniqueCode=${uniqueCode}&limit=20`)
      
      // 3. Position history (recent trades)
      const posHistory = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-subpositions-history?instType=SWAP&uniqueCode=${uniqueCode}&limit=50`)
      
      // Calculate metrics from weekly PnL
      const weeks = weeklyPnl?.data || []
      let totalPnl = 0
      let winWeeks = 0
      const equityCurve = []
      
      for (const w of weeks) {
        const pnl = parseFloat(w.pnl ?? 0)
        totalPnl += pnl
        if (pnl > 0) winWeeks++
        equityCurve.push({
          date: new Date(parseInt(w.beginTs)).toISOString().split('T')[0],
          pnl_usd: pnl,
          roi_pct: parseFloat(w.pnlRatio ?? 0) * 100,
        })
      }
      
      // Count trades from history
      const trades = posHistory?.data || []
      let winTrades = 0
      for (const trade of trades) {
        if (parseFloat(trade.pnl ?? 0) > 0) winTrades++
      }
      
      const metrics = {
        roi_pct: t.roi ?? null,
        pnl_usd: totalPnl || t.pnl || null,
        win_rate: trades.length > 0 ? (winTrades / trades.length) * 100 : (t.win_rate ?? null),
        max_drawdown: t.max_drawdown ?? null,
        trades_count: trades.length || t.trades_count || null,
        followers: null,
        copiers: null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('okx', 'futures', uniqueCode, '30d', metrics)
      }
      
      await upsertProfile('okx', 'futures', uniqueCode, {
        display_name: t.nickname,
        avatar_url: t.avatar_url,
        profile_url: `https://www.okx.com/copy-trading/account/${uniqueCode}`,
      })
      
      // Upsert current positions
      if (currentPos?.data?.length) {
        const posData = currentPos.data
          .filter(p => p.instId && p.instId !== '')  // skip entries without instId
          .map(p => ({
            symbol: p.instId || 'UNKNOWN',
            side: p.posSide === 'long' ? 'long' : 'short',
            entry_price: parseFloat(p.openAvgPx || 0) || 0.01,  // fallback to avoid NOT NULL
            quantity: parseFloat(p.subPos ?? 0),
            leverage: parseFloat(p.lever ?? 1),
            margin: parseFloat(p.margin ?? 0),
            unrealized_pnl: parseFloat(p.upl ?? 0),
            unrealized_pnl_pct: parseFloat(p.uplRatio ?? 0) * 100,
          }))
        if (posData.length) await upsertPositions('okx', uniqueCode, posData)
      }
      
      // Upsert equity curve
      if (equityCurve.length) {
        await upsertEquityCurve('okx_futures', uniqueCode, 'WEEKLY', equityCurve)
      }
      
      enriched++
      if (enriched % 10 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(300)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// BYBIT enrichment
// ============================================
async function enrichBybit() {
  console.log('\n🔵 Bybit - Detail API enrichment')
  const traders = await getTradersToEnrich('bybit', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const leaderId = t.source_trader_id
      
      // Bybit detail API
      const detail = await fetchJSON(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader-detail?leaderMark=${encodeURIComponent(leaderId)}`)
      
      if (!detail?.result) {
        // Try alternative endpoint
        const alt = await fetchJSON(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail?leaderMark=${encodeURIComponent(leaderId)}`)
        if (!alt?.result) { await sleep(200); continue }
        detail.result = alt.result
      }
      
      const r = detail.result
      const metrics = {
        roi_pct: parseFloat(r.roi ?? t.roi ?? 0) * (Math.abs(parseFloat(r.roi ?? 0)) <= 5 ? 100 : 1),
        pnl_usd: parseFloat(r.pnl ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRate ?? t.win_rate ?? 0) * (parseFloat(r.winRate ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(r.maxDrawdown ?? r.mdd ?? t.max_drawdown ?? 0) * (Math.abs(parseFloat(r.maxDrawdown ?? 0)) <= 1 ? 100 : 1),
        trades_count: parseInt(r.totalTradeCount ?? r.tradeCount ?? t.trades_count ?? 0) || null,
        sharpe_ratio: parseFloat(r.sharpeRatio ?? 0) || null,
        followers: parseInt(r.followerCount ?? 0) || null,
        copiers: parseInt(r.copierCount ?? 0) || null,
        aum: parseFloat(r.aum ?? 0) || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('bybit', 'futures', leaderId, '30d', metrics)
      }
      
      await upsertProfile('bybit', 'futures', leaderId, {
        display_name: r.nickName || r.nickname || t.nickname,
        avatar_url: r.avatar || t.avatar_url,
        bio: r.introduction || null,
        profile_url: `https://www.bybit.com/copyTrading/trade-center?leaderMark=${encodeURIComponent(leaderId)}`,
        followers: metrics.followers,
        copiers: metrics.copiers,
        aum: metrics.aum,
      })
      
      // Bybit positions
      const posResp = await fetchJSON(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader/open-order?leaderMark=${encodeURIComponent(leaderId)}&pageNo=1&pageSize=20`)
      if (posResp?.result?.data?.length) {
        const posData = posResp.result.data.map(p => ({
          symbol: p.symbol || 'UNKNOWN',
          side: p.side?.toLowerCase() === 'buy' ? 'long' : 'short',
          entry_price: parseFloat(p.entryPrice ?? 0),
          mark_price: parseFloat(p.markPrice ?? 0),
          quantity: parseFloat(p.qty ?? p.size ?? 0),
          leverage: parseFloat(p.leverage ?? 1),
          unrealized_pnl: parseFloat(p.unrealisedPnl ?? 0),
        }))
        await upsertPositions('bybit', leaderId, posData)
      }
      
      enriched++
      if (enriched % 10 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(300)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// BITGET enrichment (via CF proxy - Cloudflare protected)
// ============================================
async function enrichBitget() {
  console.log('\n🟣 Bitget - Detail API enrichment (via CF proxy)')
  if (!CF_PROXY) {
    console.log('  ⚠ No CF proxy configured, skipping')
    return
  }
  
  const traders = await getTradersToEnrich('bitget_futures', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const traderId = t.source_trader_id
      if (!traderId || !/^\d+$/.test(traderId)) continue  // Skip non-numeric IDs
      
      // Bitget detail API (via CF proxy to bypass Cloudflare)
      const detail = await fetchJSON(`${CF_PROXY}/proxy?url=${encodeURIComponent(`https://www.bitget.com/v1/copy/mix/trader/detail?traderId=${traderId}`)}`)
      
      if (!detail?.data) { await sleep(300); continue }
      
      const r = detail.data
      const metrics = {
        roi_pct: parseFloat(r.roi ?? r.yieldRate ?? t.roi ?? 0) * (Math.abs(parseFloat(r.roi ?? 0)) <= 5 ? 100 : 1),
        pnl_usd: parseFloat(r.totalProfit ?? r.totalProfitUsdt ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRate ?? t.win_rate ?? 0) * (parseFloat(r.winRate ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(r.maxDrawDown ?? r.maxDrawdown ?? t.max_drawdown ?? 0) * (Math.abs(parseFloat(r.maxDrawDown ?? 0)) <= 1 ? 100 : 1),
        trades_count: parseInt(r.totalTrades ?? r.tradeCount ?? t.trades_count ?? 0) || null,
        sharpe_ratio: parseFloat(r.sharpeRatio ?? 0) || null,
        followers: parseInt(r.followerNum ?? r.followerCount ?? 0) || null,
        copiers: parseInt(r.copierNum ?? r.currentCopyNum ?? 0) || null,
        aum: parseFloat(r.aum ?? r.totalMarginBalance ?? 0) || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('bitget', 'futures', traderId, '30d', metrics)
      }
      
      await upsertProfile('bitget', 'futures', traderId, {
        display_name: r.nickname || r.nickName || t.nickname,
        avatar_url: r.avatar || r.headPic || t.avatar_url,
        bio: r.introduction || null,
        profile_url: `https://www.bitget.com/copy-trading/trader/${traderId}`,
        followers: metrics.followers,
        copiers: metrics.copiers,
        aum: metrics.aum,
      })
      
      // Bitget positions
      const posResp = await fetchJSON(`${CF_PROXY}/proxy?url=${encodeURIComponent(`https://www.bitget.com/v1/copy/mix/trader/current-track?traderId=${traderId}&pageNo=1&pageSize=20`)}`)
      if (posResp?.data?.length) {
        const posData = posResp.data.map(p => ({
          symbol: p.symbol || 'UNKNOWN',
          side: p.holdSide?.toLowerCase() === 'long' ? 'long' : 'short',
          entry_price: parseFloat(p.openPrice ?? p.averageOpenPrice ?? 0),
          mark_price: parseFloat(p.markPrice ?? 0),
          quantity: parseFloat(p.holdAmount ?? p.total ?? 0),
          leverage: parseFloat(p.leverage ?? 1),
          unrealized_pnl: parseFloat(p.unrealizedPL ?? 0),
          unrealized_pnl_pct: parseFloat(p.profitRate ?? 0) * 100,
        }))
        await upsertPositions('bitget', traderId, posData)
      }
      
      // Bitget profit curve
      const curve = await fetchJSON(`${CF_PROXY}/proxy?url=${encodeURIComponent(`https://www.bitget.com/v1/copy/mix/trader/profit-date-detail?traderId=${traderId}&pageSize=90`)}`)
      if (curve?.data?.length) {
        const curves = curve.data.map(p => ({
          date: new Date(parseInt(p.date || p.cTime)).toISOString().split('T')[0],
          pnl_usd: parseFloat(p.profit ?? 0),
          roi_pct: parseFloat(p.profitRate ?? 0) * 100,
        }))
        await upsertEquityCurve('bitget_futures', traderId, '90D', curves)
      }
      
      enriched++
      if (enriched % 10 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(500)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// HTX enrichment
// ============================================
async function enrichHTX() {
  console.log('\n🔴 HTX - Detail API enrichment')
  const traders = await getTradersToEnrich('htx_futures', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const uid = t.source_trader_id
      
      // HTX copy trader detail
      const detail = await fetchJSON(`https://www.htx.com/v3/strategy/follow/get_copy_trader_detail?uid=${uid}`)
      
      if (!detail?.data) {
        // Try alternative endpoint
        const alt = await fetchJSON(`https://www.htx.com/-/x/hbg/v1/copytrading/public/trader/detail?uid=${uid}`)
        if (!alt?.data) { await sleep(200); continue }
        detail.data = alt.data
      }
      
      const r = detail.data
      const metrics = {
        roi_pct: parseFloat(r.yieldRate ?? r.roi ?? t.roi ?? 0) * (Math.abs(parseFloat(r.yieldRate ?? 0)) <= 5 ? 100 : 1),
        pnl_usd: parseFloat(r.totalProfit ?? r.pnl ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRate ?? t.win_rate ?? 0) * (parseFloat(r.winRate ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(r.maxDrawdown ?? r.mdd ?? t.max_drawdown ?? 0) * (Math.abs(parseFloat(r.maxDrawdown ?? 0)) <= 1 ? 100 : 1),
        trades_count: parseInt(r.totalTransNum ?? r.tradeCount ?? t.trades_count ?? 0) || null,
        sharpe_ratio: parseFloat(r.sharpeRatio ?? 0) || null,
        followers: parseInt(r.followCount ?? r.followerCount ?? 0) || null,
        copiers: parseInt(r.copyCount ?? r.copyTraderCount ?? 0) || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('htx', 'futures', uid, '30d', metrics)
      }
      
      await upsertProfile('htx', 'futures', uid, {
        display_name: r.nickName || r.nickname || t.nickname,
        avatar_url: r.avatar || r.headUrl || t.avatar_url,
        bio: r.introduction || null,
        profile_url: `https://www.htx.com/copy-trading/trader/${uid}`,
        followers: metrics.followers,
        copiers: metrics.copiers,
      })
      
      enriched++
      if (enriched % 10 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(300)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// MEXC enrichment
// ============================================
async function enrichMEXC() {
  console.log('\n🟠 MEXC - Detail API enrichment')
  const traders = await getTradersToEnrich('mexc', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const traderId = t.source_trader_id
      
      // MEXC contract API (might be geo-blocked, use proxy)
      let detail = await fetchJSON(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/detail?traderId=${encodeURIComponent(traderId)}`)
      
      if (!detail?.data) {
        // Try newer API
        detail = await fetchJSON(`https://www.mexc.com/api/platform/copy-trade/trader/detail?traderId=${encodeURIComponent(traderId)}`)
      }
      
      if (!detail?.data) { await sleep(200); continue }
      
      const r = detail.data
      const metrics = {
        roi_pct: parseFloat(r.roi ?? r.yieldRate ?? t.roi ?? 0) * (Math.abs(parseFloat(r.roi ?? 0)) <= 5 ? 100 : 1),
        pnl_usd: parseFloat(r.totalProfit ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRatio ?? r.winRate ?? t.win_rate ?? 0) * (parseFloat(r.winRatio ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(r.maxDrawdown ?? t.max_drawdown ?? 0) * (Math.abs(parseFloat(r.maxDrawdown ?? 0)) <= 1 ? 100 : 1),
        trades_count: parseInt(r.totalTrades ?? r.tradeCount ?? t.trades_count ?? 0) || null,
        followers: parseInt(r.followerNum ?? 0) || null,
        copiers: parseInt(r.currentCopyNum ?? 0) || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('mexc', 'futures', traderId, '30d', metrics)
      }
      
      await upsertProfile('mexc', 'futures', traderId, {
        display_name: r.nickName || t.nickname,
        avatar_url: r.avatar || t.avatar_url,
        profile_url: `https://www.mexc.com/copy-trading/trader/${traderId}`,
        followers: metrics.followers,
        copiers: metrics.copiers,
      })
      
      enriched++
      if (enriched % 10 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(300)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// KUCOIN enrichment
// ============================================
async function enrichKuCoin() {
  console.log('\n🟤 KuCoin - Detail API enrichment')
  const traders = await getTradersToEnrich('kucoin', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const traderId = t.source_trader_id
      
      const detail = await fetchJSON(`https://www.kucoin.com/_api/copy-trading/future/public/trader/detail?traderId=${traderId}`)
      
      if (!detail?.data) { await sleep(200); continue }
      
      const r = detail.data
      const metrics = {
        roi_pct: parseFloat(r.roi ?? t.roi ?? 0) * (Math.abs(parseFloat(r.roi ?? 0)) <= 5 ? 100 : 1),
        pnl_usd: parseFloat(r.pnl ?? r.totalProfit ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRate ?? t.win_rate ?? 0) * (parseFloat(r.winRate ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(r.maxDrawdown ?? r.mdd ?? t.max_drawdown ?? 0) * (Math.abs(parseFloat(r.maxDrawdown ?? 0)) <= 1 ? 100 : 1),
        trades_count: parseInt(r.tradeCount ?? r.totalTrades ?? t.trades_count ?? 0) || null,
        sharpe_ratio: parseFloat(r.sharpeRatio ?? 0) || null,
        followers: parseInt(r.followerCount ?? 0) || null,
        copiers: parseInt(r.copierCount ?? 0) || null,
        aum: parseFloat(r.aum ?? 0) || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('kucoin', 'futures', traderId, '30d', metrics)
      }
      
      await upsertProfile('kucoin', 'futures', traderId, {
        display_name: r.nickName || t.nickname,
        avatar_url: r.avatar || t.avatar_url,
        profile_url: `https://www.kucoin.com/copy-trading/trader/${traderId}`,
        followers: metrics.followers,
        copiers: metrics.copiers,
        aum: metrics.aum,
      })
      
      enriched++
      if (enriched % 10 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(300)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// HYPERLIQUID enrichment
// ============================================
async function enrichHyperliquid() {
  console.log('\n🔮 Hyperliquid - Detail API enrichment')
  const traders = await getTradersToEnrich('hyperliquid', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const address = t.source_trader_id
      if (!address?.startsWith('0x')) continue
      
      // 1. Clearinghouse state (current positions + account value)
      const state = await postJSON('https://api.hyperliquid.xyz/info', {
        type: 'clearinghouseState', user: address
      })
      
      // 2. User fills (trade history)
      const fills = await postJSON('https://api.hyperliquid.xyz/info', {
        type: 'userFills', user: address
      })
      
      // 3. User funding history for more complete picture
      const funding = await postJSON('https://api.hyperliquid.xyz/info', {
        type: 'userFunding', user: address
      })
      
      // Extract metrics
      const accountValue = parseFloat(state?.marginSummary?.accountValue ?? state?.crossMarginSummary?.accountValue ?? 0)
      
      // Count wins from fills
      const recentFills = Array.isArray(fills) ? fills.slice(0, 200) : []
      let winTrades = 0, totalTrades = 0
      // Group fills by position (simplified)
      for (const fill of recentFills) {
        if (fill.closedPnl && parseFloat(fill.closedPnl) !== 0) {
          totalTrades++
          if (parseFloat(fill.closedPnl) > 0) winTrades++
        }
      }
      
      const metrics = {
        roi_pct: t.roi ?? null,
        pnl_usd: t.pnl ?? null,
        win_rate: totalTrades > 0 ? (winTrades / totalTrades) * 100 : (t.win_rate ?? null),
        max_drawdown: t.max_drawdown ?? null,
        trades_count: totalTrades || t.trades_count || null,
        aum: accountValue || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('hyperliquid', 'perp', address, '30d', metrics)
      }
      
      await upsertProfile('hyperliquid', 'perp', address, {
        display_name: t.nickname || address.slice(0, 10),
        profile_url: `https://app.hyperliquid.xyz/explorer/${address}`,
        aum: accountValue || null,
      })
      
      // Positions
      const assetPositions = state?.assetPositions || []
      if (assetPositions.length) {
        const posData = assetPositions.filter(p => parseFloat(p.position?.szi ?? 0) !== 0).map(p => {
          const pos = p.position
          const szi = parseFloat(pos.szi ?? 0)
          return {
            symbol: pos.coin || 'UNKNOWN',
            side: szi >= 0 ? 'long' : 'short',
            entry_price: parseFloat(pos.entryPx ?? 0),
            mark_price: 0,
            quantity: Math.abs(szi),
            leverage: parseFloat(pos.leverage?.value ?? 1),
            margin: parseFloat(pos.marginUsed ?? 0),
            unrealized_pnl: parseFloat(pos.unrealizedPnl ?? 0),
            unrealized_pnl_pct: parseFloat(pos.returnOnEquity ?? 0) * 100,
          }
        })
        await upsertPositions('hyperliquid', address, posData)
      }
      
      enriched++
      if (enriched % 20 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(200)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// GMX enrichment (via subgraph)
// ============================================
async function enrichGMX() {
  console.log('\n🔷 GMX - Subgraph enrichment')
  const traders = await getTradersToEnrich('gmx', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  const SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
  
  let enriched = 0
  for (const t of traders) {
    try {
      const account = t.source_trader_id
      if (!account?.startsWith('0x')) continue
      
      // Query full account stats from subgraph
      const query = `{
        accountStats(where: {id_eq: "${account.toLowerCase()}"}) {
          id closedCount volume losses wins
        }
        positions(where: {account_eq: "${account.toLowerCase()}", isLong_eq: true}, orderBy: size_DESC, limit: 20) {
          market size collateralAmount isLong entryPrice
        }
      }`
      
      const result = await postJSON(SUBSQUID_URL, { query })
      
      const stats = result?.data?.accountStats?.[0]
      const positions = result?.data?.positions || []
      
      if (stats) {
        const wins = parseInt(stats.wins ?? 0)
        const losses = parseInt(stats.losses ?? 0)
        const total = wins + losses
        
        const metrics = {
          roi_pct: t.roi ?? null,
          pnl_usd: t.pnl ?? null,
          win_rate: total > 0 ? (wins / total) * 100 : (t.win_rate ?? null),
          max_drawdown: t.max_drawdown ?? null,
          trades_count: parseInt(stats.closedCount ?? total) || t.trades_count || null,
        }
        
        await upsertSnapshot('gmx', 'perp', account, '30d', metrics)
      }
      
      await upsertProfile('gmx', 'perp', account, {
        display_name: t.nickname || account.slice(0, 10),
        profile_url: `https://app.gmx.io/#/actions/${account}`,
      })
      
      enriched++
      if (enriched % 20 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(200)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// dYdX enrichment
// ============================================
async function enrichDYDX() {
  console.log('\n🟪 dYdX - Indexer API enrichment')
  const traders = await getTradersToEnrich('dydx', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const address = t.source_trader_id
      
      // dYdX v4 indexer - subaccount
      const subaccount = await fetchJSON(`https://indexer.dydx.trade/v4/addresses/${address}/subaccountNumber/0`)
      
      // Historical PnL
      const pnlHistory = await fetchJSON(`https://indexer.dydx.trade/v4/historical-pnl?address=${address}&subaccountNumber=0&limit=90`)
      
      // Positions
      const posResp = await fetchJSON(`https://indexer.dydx.trade/v4/perpetualPositions?address=${address}&subaccountNumber=0&status=OPEN`)
      
      // Fills (trades)
      const fillsResp = await fetchJSON(`https://indexer.dydx.trade/v4/fills?address=${address}&subaccountNumber=0&limit=100`)
      
      const equity = parseFloat(subaccount?.subaccount?.equity ?? 0)
      
      // Calculate from historical PnL
      const pnlData = pnlHistory?.historicalPnl || []
      let totalPnl = 0
      const equityCurve = []
      for (const p of pnlData) {
        const pnl = parseFloat(p.totalPnl ?? 0)
        totalPnl = pnl  // last entry has cumulative
        equityCurve.push({
          date: new Date(p.createdAt).toISOString().split('T')[0],
          pnl_usd: pnl,
        })
      }
      
      // Count wins from fills
      const fills = fillsResp?.fills || []
      // Simplified: group by orderId and check if profitable
      let winTrades = 0, lossTrades = 0
      for (const f of fills) {
        const pnl = parseFloat(f.realizedPnl ?? 0)
        if (pnl > 0) winTrades++
        else if (pnl < 0) lossTrades++
      }
      const totalTrades = winTrades + lossTrades
      
      const metrics = {
        roi_pct: t.roi ?? null,
        pnl_usd: totalPnl || t.pnl || null,
        win_rate: totalTrades > 0 ? (winTrades / totalTrades) * 100 : (t.win_rate ?? null),
        max_drawdown: t.max_drawdown ?? null,
        trades_count: totalTrades || t.trades_count || null,
        aum: equity || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('dydx', 'perp', address, '30d', metrics)
      }
      
      await upsertProfile('dydx', 'perp', address, {
        display_name: t.nickname || address.slice(0, 10),
        profile_url: `https://dydx.exchange/profile/${address}`,
        aum: equity || null,
      })
      
      // Positions
      const openPos = posResp?.positions || []
      if (openPos.length) {
        const posData = openPos.map(p => ({
          symbol: p.market || 'UNKNOWN',
          side: p.side === 'LONG' ? 'long' : 'short',
          entry_price: parseFloat(p.entryPrice ?? 0),
          quantity: parseFloat(p.size ?? 0),
          unrealized_pnl: parseFloat(p.unrealizedPnl ?? 0),
        }))
        await upsertPositions('dydx', address, posData)
      }
      
      // Equity curve
      if (equityCurve.length) {
        await upsertEquityCurve('dydx', address, '90D', equityCurve)
      }
      
      enriched++
      if (enriched % 10 === 0) console.log(`  ✅ ${enriched}/${traders.length}`)
      await sleep(200)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// COINEX enrichment
// ============================================
async function enrichCoinEx() {
  console.log('\n⬜ CoinEx - Detail API enrichment')
  const traders = await getTradersToEnrich('coinex', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const traderId = t.source_trader_id
      const detail = await fetchJSON(`https://www.coinex.com/res/copytrading/trader/info?trader_id=${traderId}`)
      
      if (!detail?.data) { await sleep(200); continue }
      
      const r = detail.data
      const metrics = {
        roi_pct: parseFloat(r.roi ?? t.roi ?? 0) * (Math.abs(parseFloat(r.roi ?? 0)) <= 5 ? 100 : 1),
        pnl_usd: parseFloat(r.total_profit ?? t.pnl ?? 0),
        win_rate: parseFloat(r.win_rate ?? t.win_rate ?? 0) * (parseFloat(r.win_rate ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(r.max_drawdown ?? t.max_drawdown ?? 0) * (Math.abs(parseFloat(r.max_drawdown ?? 0)) <= 1 ? 100 : 1),
        trades_count: parseInt(r.total_trades ?? t.trades_count ?? 0) || null,
        followers: parseInt(r.follower_count ?? 0) || null,
        copiers: parseInt(r.copier_count ?? 0) || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('coinex', 'futures', traderId, '30d', metrics)
      }
      
      await upsertProfile('coinex', 'futures', traderId, {
        display_name: r.nickname || t.nickname,
        avatar_url: r.avatar || t.avatar_url,
        profile_url: `https://www.coinex.com/copy-trading/trader/${traderId}`,
        followers: metrics.followers,
        copiers: metrics.copiers,
      })
      
      enriched++
      await sleep(300)
    } catch (e) {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// Additional platforms - Gains, Jupiter, Aevo
// ============================================

async function enrichGains() {
  console.log('\n🟩 Gains Network - enrichment')
  const traders = await getTradersToEnrich('gains', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const address = t.source_trader_id
      if (!address?.startsWith('0x')) continue
      
      // Gains open trades
      const openTrades = await fetchJSON(`https://backend-arbitrum.gains.trade/api/v1/open-trades/${address}`)
      
      const trades = Array.isArray(openTrades) ? openTrades : (openTrades?.trades || [])
      
      if (trades.length) {
        const posData = trades.map(tr => ({
          symbol: tr.pairIndex != null ? `PAIR_${tr.pairIndex}` : 'UNKNOWN',
          side: tr.buy ? 'long' : 'short',
          entry_price: parseFloat(tr.openPrice ?? 0),
          quantity: parseFloat(tr.positionSizeStable ?? tr.collateralAmount ?? 0),
          leverage: parseFloat(tr.leverage ?? 1),
        }))
        await upsertPositions('gains', address, posData)
      }
      
      await upsertProfile('gains', 'perp', address, {
        display_name: t.nickname || address.slice(0, 10),
        profile_url: `https://gains.trade/trading#${address}`,
      })
      
      enriched++
      await sleep(200)
    } catch {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

async function enrichJupiter() {
  console.log('\n🪐 Jupiter Perps - enrichment')
  const traders = await getTradersToEnrich('jupiter_perps', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const address = t.source_trader_id
      
      // Jupiter perps positions
      const positions = await fetchJSON(`https://perps-api.jup.ag/v1/positions?wallet=${address}`)
      
      if (Array.isArray(positions) && positions.length) {
        const posData = positions.map(p => ({
          symbol: p.market || p.marketSymbol || 'UNKNOWN',
          side: p.side === 'long' ? 'long' : 'short',
          entry_price: parseFloat(p.entryPrice ?? 0),
          quantity: parseFloat(p.size ?? 0),
          leverage: parseFloat(p.leverage ?? 1),
          unrealized_pnl: parseFloat(p.unrealizedPnl ?? 0),
        }))
        await upsertPositions('jupiter_perps', address, posData)
      }
      
      await upsertProfile('jupiter_perps', 'perp', address, {
        display_name: t.nickname || address.slice(0, 8),
        profile_url: `https://jup.ag/perps/${address}`,
      })
      
      enriched++
      await sleep(200)
    } catch {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

async function enrichAevo() {
  console.log('\n🔶 Aevo - enrichment')
  const traders = await getTradersToEnrich('aevo', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const account = t.source_trader_id
      
      // Aevo account stats
      const stats = await fetchJSON(`https://api.aevo.xyz/statistics?account=${account}`)
      // Aevo positions
      const positions = await fetchJSON(`https://api.aevo.xyz/positions?account=${account}`)
      
      if (stats) {
        const metrics = {
          roi_pct: t.roi ?? null,
          pnl_usd: parseFloat(stats.total_pnl ?? stats.pnl ?? t.pnl ?? 0),
          win_rate: parseFloat(stats.win_rate ?? t.win_rate ?? 0) * (parseFloat(stats.win_rate ?? 0) <= 1 ? 100 : 1),
          trades_count: parseInt(stats.total_trades ?? t.trades_count ?? 0) || null,
        }
        
        if (metrics.roi_pct) {
          await upsertSnapshot('aevo', 'perp', account, '30d', metrics)
        }
      }
      
      if (Array.isArray(positions) && positions.length) {
        const posData = positions.map(p => ({
          symbol: p.instrument_name || 'UNKNOWN',
          side: parseFloat(p.amount ?? 0) >= 0 ? 'long' : 'short',
          entry_price: parseFloat(p.avg_entry_price ?? 0),
          mark_price: parseFloat(p.mark_price ?? 0),
          quantity: Math.abs(parseFloat(p.amount ?? 0)),
          leverage: parseFloat(p.leverage ?? 1),
          unrealized_pnl: parseFloat(p.unrealized_pnl ?? 0),
        }))
        await upsertPositions('aevo', account, posData)
      }
      
      await upsertProfile('aevo', 'perp', account, {
        display_name: t.nickname || account.slice(0, 10),
        profile_url: `https://app.aevo.xyz/portfolio/${account}`,
      })
      
      enriched++
      await sleep(200)
    } catch {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// WEEX, Phemex, BingX, XT, LBank
// ============================================

async function enrichWeex() {
  console.log('\n⬛ WEEX - Detail API enrichment')
  const traders = await getTradersToEnrich('weex', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const traderId = t.source_trader_id
      const detail = await fetchJSON(`https://www.weex.com/api/v1/copy-trade/leader/detail?leaderId=${traderId}`)
      if (!detail?.data) { await sleep(200); continue }
      
      const r = detail.data
      const metrics = {
        roi_pct: parseFloat(r.roi ?? t.roi ?? 0) * (Math.abs(parseFloat(r.roi ?? 0)) <= 5 ? 100 : 1),
        pnl_usd: parseFloat(r.totalProfit ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRate ?? t.win_rate ?? 0) * (parseFloat(r.winRate ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(r.maxDrawdown ?? t.max_drawdown ?? 0) * (Math.abs(parseFloat(r.maxDrawdown ?? 0)) <= 1 ? 100 : 1),
        trades_count: parseInt(r.totalTrades ?? t.trades_count ?? 0) || null,
        followers: parseInt(r.followerCount ?? 0) || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('weex', 'futures', traderId, '30d', metrics)
      }
      await upsertProfile('weex', 'futures', traderId, {
        display_name: r.nickname || t.nickname,
        avatar_url: r.avatar || t.avatar_url,
        profile_url: `https://www.weex.com/copy-trading/trader/${traderId}`,
        followers: metrics.followers,
      })
      
      enriched++
      await sleep(300)
    } catch {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

async function enrichPhemex() {
  console.log('\n🟧 Phemex - Detail API enrichment')
  const traders = await getTradersToEnrich('phemex', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const traderId = t.source_trader_id
      const detail = await fetchJSON(`https://api.phemex.com/phemex-user/users/children/${traderId}/trading-stats`)
      if (!detail?.data) { await sleep(200); continue }
      
      const r = detail.data
      const metrics = {
        roi_pct: parseFloat(r.roi ?? t.roi ?? 0) * 100,
        pnl_usd: parseFloat(r.totalPnl ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRate ?? t.win_rate ?? 0) * 100,
        max_drawdown: parseFloat(r.maxDrawdown ?? t.max_drawdown ?? 0) * 100,
        trades_count: parseInt(r.totalTrades ?? t.trades_count ?? 0) || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('phemex', 'futures', traderId, '30d', metrics)
      }
      await upsertProfile('phemex', 'futures', traderId, {
        display_name: r.nickname || t.nickname,
        avatar_url: r.avatarUrl || t.avatar_url,
        profile_url: `https://www.phemex.com/copy-trading/trader/${traderId}`,
      })
      
      enriched++
      await sleep(300)
    } catch {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

async function enrichXT() {
  console.log('\n🔳 XT - Detail API enrichment')
  const traders = await getTradersToEnrich('xt', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const traderId = t.source_trader_id
      const detail = await fetchJSON(`https://www.xt.com/copytrade/api/public/v1/trader/detail?traderId=${traderId}`)
      if (!detail?.result) { await sleep(200); continue }
      
      const r = detail.result
      const metrics = {
        roi_pct: parseFloat(r.roi ?? t.roi ?? 0) * (Math.abs(parseFloat(r.roi ?? 0)) <= 5 ? 100 : 1),
        pnl_usd: parseFloat(r.totalProfit ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRate ?? t.win_rate ?? 0) * (parseFloat(r.winRate ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(r.maxDrawdown ?? t.max_drawdown ?? 0) * (Math.abs(parseFloat(r.maxDrawdown ?? 0)) <= 1 ? 100 : 1),
        trades_count: parseInt(r.totalTrades ?? t.trades_count ?? 0) || null,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('xt', 'futures', traderId, '30d', metrics)
      }
      await upsertProfile('xt', 'futures', traderId, {
        display_name: r.nickname || t.nickname,
        avatar_url: r.avatar || t.avatar_url,
        profile_url: `https://www.xt.com/copy-trading/trader/${traderId}`,
      })
      
      enriched++
      await sleep(300)
    } catch {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

async function enrichLBank() {
  console.log('\n🏦 LBank - Detail API enrichment')
  const traders = await getTradersToEnrich('lbank', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const traderId = t.source_trader_id
      const detail = await fetchJSON(`https://www.lbank.com/v2/supplement/copy_trade/trader/detail?traderId=${traderId}`)
      if (!detail?.data) { await sleep(200); continue }
      
      const r = detail.data
      const metrics = {
        roi_pct: parseFloat(r.roi ?? t.roi ?? 0) * (Math.abs(parseFloat(r.roi ?? 0)) <= 5 ? 100 : 1),
        pnl_usd: parseFloat(r.totalProfit ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRate ?? t.win_rate ?? 0) * (parseFloat(r.winRate ?? 0) <= 1 ? 100 : 1),
        max_drawdown: parseFloat(r.maxDrawdown ?? t.max_drawdown ?? 0) * 100,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('lbank', 'futures', traderId, '30d', metrics)
      }
      await upsertProfile('lbank', 'futures', traderId, {
        display_name: r.nickname || t.nickname,
        avatar_url: r.avatar || t.avatar_url,
        profile_url: `https://www.lbank.com/copy-trading/trader/${traderId}`,
      })
      
      enriched++
      await sleep(300)
    } catch {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

async function enrichBingX() {
  console.log('\n📈 BingX - Detail API enrichment')
  const traders = await getTradersToEnrich('bingx', LIMIT)
  console.log(`  Found ${traders.length} traders to enrich`)
  
  let enriched = 0
  for (const t of traders) {
    try {
      const traderId = t.source_trader_id
      const detail = await fetchJSON(`https://api.bingx.com/api/v1/copy/mix/trader/detail?traderId=${traderId}`)
      if (!detail?.data) { await sleep(200); continue }
      
      const r = detail.data
      const metrics = {
        roi_pct: parseFloat(r.roi ?? t.roi ?? 0) * 100,
        pnl_usd: parseFloat(r.totalProfit ?? t.pnl ?? 0),
        win_rate: parseFloat(r.winRate ?? t.win_rate ?? 0) * 100,
        max_drawdown: parseFloat(r.maxDrawdown ?? t.max_drawdown ?? 0) * 100,
      }
      
      if (metrics.roi_pct) {
        await upsertSnapshot('bingx', 'futures', traderId, '30d', metrics)
      }
      enriched++
      await sleep(300)
    } catch {}
  }
  console.log(`  ✅ Enriched ${enriched}/${traders.length}`)
}

// ============================================
// Main
// ============================================

const PLATFORM_MAP = {
  binance: enrichBinanceFutures,
  okx: enrichOKX,
  bybit: enrichBybit,
  bitget: enrichBitget,
  htx: enrichHTX,
  mexc: enrichMEXC,
  kucoin: enrichKuCoin,
  hyperliquid: enrichHyperliquid,
  gmx: enrichGMX,
  dydx: enrichDYDX,
  coinex: enrichCoinEx,
  gains: enrichGains,
  jupiter: enrichJupiter,
  aevo: enrichAevo,
  weex: enrichWeex,
  phemex: enrichPhemex,
  xt: enrichXT,
  lbank: enrichLBank,
  bingx: enrichBingX,
}

async function main() {
  console.log('🚀 Detail API Enrichment - 全平台数据充实')
  console.log(`   CF Proxy: ${CF_PROXY || '未配置'}`)
  console.log(`   Limit: ${LIMIT} per platform`)
  console.log(`   Fresh only: ${freshOnly}`)
  console.log(`   Platform filter: ${platformFilter || 'ALL'}`)
  console.log()
  
  const startTime = Date.now()
  
  if (platformFilter) {
    const fn = PLATFORM_MAP[platformFilter]
    if (!fn) {
      console.error(`❌ Unknown platform: ${platformFilter}`)
      console.log(`Available: ${Object.keys(PLATFORM_MAP).join(', ')}`)
      process.exit(1)
    }
    await fn()
  } else {
    // Run all platforms in order of data volume
    for (const [name, fn] of Object.entries(PLATFORM_MAP)) {
      try {
        await fn()
      } catch (e) {
        console.error(`  ❌ ${name} failed: ${e.message}`)
      }
    }
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n✅ 全部完成! 耗时 ${elapsed}s`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
