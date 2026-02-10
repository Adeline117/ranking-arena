/**
 * Local script to trigger leaderboard computation.
 * Usage: node scripts/compute-leaderboard-local.mjs
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

async function main() {
  // We'll call the API directly via fetch, but since the app may not be running,
  // let's do it inline using the same logic.
  
  const { createClient } = await import('@supabase/supabase-js')
  
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )

  // Dynamically import arena-score (it's TypeScript, so we use tsx or compile)
  // Instead, inline the core calculation to avoid TS compilation issues.
  
  const ALL_SOURCES = [
    'binance_futures', 'bybit', 'bitget_futures', 'mexc', 'coinex',
    'okx_futures', 'kucoin', 'bitmart', 'phemex', 'htx_futures',
    'weex', 'bingx', 'gateio', 'xt', 'pionex', 'lbank', 'blofin',
    'binance_spot', 'bitget_spot', 'bybit_spot', 'okx_spot',
    'binance_web3', 'okx_web3', 'okx_wallet',
    'gmx', 'dydx', 'hyperliquid', 'kwenta', 'gains', 'mux',
    'vertex', 'drift', 'jupiter_perps', 'aevo', 'synthetix',
    'dune_gmx', 'dune_hyperliquid', 'dune_uniswap', 'dune_defi',
  ]

  const SOURCE_TYPE_MAP = {
    binance_futures: 'futures', bybit: 'futures', bitget_futures: 'futures',
    mexc: 'futures', coinex: 'futures', okx_futures: 'futures',
    kucoin: 'futures', bitmart: 'futures', phemex: 'futures',
    htx_futures: 'futures', weex: 'futures', bingx: 'futures',
    gateio: 'futures', xt: 'futures', pionex: 'futures',
    lbank: 'futures', blofin: 'futures',
    binance_spot: 'spot', bitget_spot: 'spot', bybit_spot: 'spot', okx_spot: 'spot',
    binance_web3: 'web3', okx_web3: 'web3', okx_wallet: 'web3',
    gmx: 'web3', dydx: 'web3', hyperliquid: 'web3', kwenta: 'web3',
    gains: 'web3', mux: 'web3', vertex: 'web3', drift: 'web3',
    jupiter_perps: 'web3', aevo: 'web3', synthetix: 'web3',
    dune_gmx: 'web3', dune_hyperliquid: 'web3', dune_uniswap: 'spot', dune_defi: 'web3',
  }

  // Inline arena score calculation (V2)
  function clip(v, min, max) { return Math.max(min, Math.min(max, v)) }
  function safeLog1p(x) { return x <= -1 ? 0 : Math.log(1 + x) }
  
  const PARAMS = {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  }
  const PNL_PARAMS = {
    '7D': { base: 500, coeff: 0.40 },
    '30D': { base: 2000, coeff: 0.35 },
    '90D': { base: 5000, coeff: 0.30 },
  }
  const CONF_MULT = { full: 1.0, partial: 0.92, minimal: 0.80 }

  function calcScore(roi, pnl, maxDrawdown, winRate, period) {
    const p = PARAMS[period]
    const cappedRoi = Math.min(roi, 10000)
    const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
    const intensity = (365 / days) * safeLog1p(cappedRoi / 100)
    const r0 = Math.tanh(p.tanhCoeff * intensity)
    const returnScore = r0 > 0 ? clip(70 * Math.pow(r0, p.roiExponent), 0, 70) : 0

    let pnlScore = 0
    if (pnl > 0) {
      const pp = PNL_PARAMS[period]
      const la = 1 + pnl / pp.base
      if (la > 0) pnlScore = clip(15 * Math.tanh(pp.coeff * Math.log(la)), 0, 15)
    }

    const effMdd = (!maxDrawdown || maxDrawdown === 0) ? -20 : maxDrawdown
    const mddAbs = Math.abs(effMdd)
    const normMdd = mddAbs <= 1 ? mddAbs * 100 : mddAbs
    const drawdownScore = clip(8 * clip(1 - normMdd / p.mddThreshold, 0, 1), 0, 8)

    const effWr = (winRate == null) ? 50 : winRate
    const normWr = (effWr <= 1 && effWr >= 0) ? effWr * 100 : effWr
    const stabilityScore = clip(7 * clip((normWr - 45) / (p.winRateCap - 45), 0, 1), 0, 7)

    const hasMdd = maxDrawdown != null && maxDrawdown !== 0
    const hasWr = winRate != null && winRate !== 0
    const conf = (hasMdd && hasWr) ? 'full' : (hasMdd || hasWr) ? 'partial' : 'minimal'
    
    const raw = returnScore + pnlScore + drawdownScore + stabilityScore
    return Math.round(clip(raw * CONF_MULT[conf], 0, 100) * 100) / 100
  }

  const seasons = ['7D', '30D', '90D']
  const freshnessThreshold = new Date()
  freshnessThreshold.setHours(freshnessThreshold.getHours() - 24)
  const freshnessISO = freshnessThreshold.toISOString()

  for (const season of seasons) {
    console.log(`\n=== Computing ${season} ===`)
    
    const allSnapshots = []
    
    for (let i = 0; i < ALL_SOURCES.length; i += 10) {
      const batch = ALL_SOURCES.slice(i, i + 10)
      const results = await Promise.all(batch.map(async (source) => {
        const rows = []
        let page = 0
        while (true) {
          const { data, error } = await supabase
            .from('trader_snapshots')
            .select('source, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, followers, captured_at')
            .eq('source', source)
            .eq('season_id', season)
            .gte('captured_at', freshnessISO)
            .order('captured_at', { ascending: false })
            .range(page * 1000, (page + 1) * 1000 - 1)
          if (error || !data?.length) break
          rows.push(...data)
          if (data.length < 1000) break
          page++
        }
        return rows
      }))
      results.forEach(r => allSnapshots.push(...r))
    }

    console.log(`  Fetched ${allSnapshots.length} snapshots`)

    // Dedupe
    const traderMap = new Map()
    for (const snap of allSnapshots) {
      const key = `${snap.source}:${snap.source_trader_id}`
      if (!traderMap.has(key)) traderMap.set(key, snap)
    }

    const unique = Array.from(traderMap.values()).filter(t => Math.abs(t.roi ?? 0) <= 10000)
    console.log(`  Unique traders: ${unique.length}`)

    if (!unique.length) continue

    // Fetch handles
    const handleMap = new Map()
    const bySource = new Map()
    for (const t of unique) {
      const ids = bySource.get(t.source) || []
      ids.push(t.source_trader_id)
      bySource.set(t.source, ids)
    }

    await Promise.all(Array.from(bySource.entries()).map(async ([source, ids]) => {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500)
        const { data } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, avatar_url')
          .eq('source', source)
          .in('source_trader_id', chunk)
        data?.forEach(s => handleMap.set(`${source}:${s.source_trader_id}`, { handle: s.handle, avatar_url: s.avatar_url }))
      }
    }))

    // Score and rank
    const scored = unique.map(t => {
      let wr = null
      if (t.win_rate != null && !isNaN(t.win_rate)) {
        wr = t.win_rate <= 1 ? t.win_rate * 100 : t.win_rate
        wr = Math.max(0, Math.min(100, wr))
      }
      const score = calcScore(t.roi ?? 0, t.pnl ?? 0, t.max_drawdown, wr, season)
      const info = handleMap.get(`${t.source}:${t.source_trader_id}`) || {}
      return {
        season_id: season,
        source: t.source,
        source_type: SOURCE_TYPE_MAP[t.source] || 'futures',
        source_trader_id: t.source_trader_id,
        rank: 0,
        arena_score: score,
        roi: t.roi ?? 0,
        pnl: t.pnl ?? 0,
        win_rate: wr,
        max_drawdown: t.max_drawdown,
        followers: Math.min(t.followers ?? 0, 2147483647),
        trades_count: t.trades_count,
        handle: (info.handle && info.handle.trim()) || t.source_trader_id,
        avatar_url: info.avatar_url || null,
        computed_at: new Date().toISOString(),
      }
    })

    scored.sort((a, b) => {
      const d = b.arena_score - a.arena_score
      if (Math.abs(d) > 0.01) return d
      return a.source_trader_id.localeCompare(b.source_trader_id)
    })
    scored.forEach((t, i) => { t.rank = i + 1 })

    // Upsert
    let upserted = 0
    for (let i = 0; i < scored.length; i += 500) {
      const batch = scored.slice(i, i + 500)
      const { error } = await supabase
        .from('leaderboard_ranks')
        .upsert(batch, { onConflict: 'season_id,source,source_trader_id' })
      if (error) {
        console.error(`  Upsert error at ${i}:`, error.message)
      } else {
        upserted += batch.length
      }
    }
    console.log(`  Upserted ${upserted} ranks`)
  }

  // Backfill missing avatars from trader_sources
  console.log('\n=== Backfilling avatars ===')
  const { count } = await supabase.rpc('exec_sql', { 
    query: `UPDATE leaderboard_ranks lr SET avatar_url = ts.avatar_url, handle = COALESCE(NULLIF(ts.handle, ''), lr.handle) FROM trader_sources ts WHERE lr.source = ts.source AND lr.source_trader_id = ts.source_trader_id AND ts.avatar_url IS NOT NULL AND lr.avatar_url IS NULL`
  }).catch(() => ({ count: null }))
  // Fallback: do it via supabase client if RPC doesn't exist
  if (count === null) {
    // Get sources with missing avatars
    const { data: missing } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id')
      .is('avatar_url', null)
      .limit(5000)
    if (missing?.length) {
      let fixed = 0
      for (const m of missing) {
        const { data: src } = await supabase
          .from('trader_sources')
          .select('avatar_url, handle')
          .eq('source', m.source)
          .eq('source_trader_id', m.source_trader_id)
          .not('avatar_url', 'is', null)
          .single()
        if (src?.avatar_url) {
          await supabase.from('leaderboard_ranks')
            .update({ avatar_url: src.avatar_url, handle: src.handle || undefined })
            .eq('source', m.source)
            .eq('source_trader_id', m.source_trader_id)
          fixed++
        }
      }
      console.log(`  Fixed ${fixed} missing avatars via client`)
    }
  }

  console.log('\nDone!')
}

main().catch(e => { console.error(e); process.exit(1) })
