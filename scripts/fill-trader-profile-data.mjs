#!/usr/bin/env node
/**
 * fill-trader-profile-data.mjs — 补齐交易员主页数据
 *
 * 1. market_type — 根据 source 名推断
 * 2. profile_url — 根据 source + source_trader_id 生成
 * 3. tracked_since — 从最早的 snapshot captured_at 推算
 * 4. followers — 从最新 snapshot 回填到 trader_sources
 *
 * Usage: node scripts/fill-trader-profile-data.mjs [--dry-run]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const DRY_RUN = process.argv.includes('--dry-run')

// ── 1. Market Type 映射 ──

const MARKET_TYPE_MAP = {
  binance_futures: 'futures',
  bitget_futures: 'futures',
  bybit: 'futures',
  mexc: 'futures',
  coinex: 'futures',
  kucoin: 'futures',
  okx_futures: 'futures',
  htx_futures: 'futures',
  phemex: 'futures',
  weex: 'futures',
  xt: 'futures',
  lbank: 'futures',
  bingx: 'futures',
  blofin: 'futures',
  bitmart: 'futures',
  binance_spot: 'spot',
  bitget_spot: 'spot',
  binance_web3: 'on-chain',
  okx_web3: 'on-chain',
  hyperliquid: 'on-chain',
  gmx: 'on-chain',
  dydx: 'on-chain',
  gains: 'on-chain',
  kwenta: 'on-chain',
  mux: 'on-chain',
}

// ── 2. Profile URL 生成 ──

const PROFILE_URL_MAP = {
  binance_futures: (id) => `https://www.binance.com/en/copy-trading/lead-details/${id}`,
  bitget_futures: (id) => `https://www.bitget.com/copy-trading/trader/${id}`,
  bitget_spot: (id) => `https://www.bitget.com/copy-trading/trader/${id}`,
  bybit: (id) => `https://www.bybit.com/copyTrading/trade-center/detail?leaderMark=${id}`,
  mexc: (id) => `https://futures.mexc.com/copy-trading/trader/${id}`,
  coinex: (id) => `https://www.coinex.com/copy-trading/trader/${id}`,
  kucoin: (id) => `https://www.kucoin.com/copy-trading/leader/${id}`,
  okx_futures: (id) => `https://www.okx.com/copy-trading/account/${id}`,
  okx_web3: (id) => `https://www.okx.com/web3/dex/positions/${id}`,
  htx_futures: (id) => `https://www.htx.com/futures/copy-trading/trader/${id}`,
  phemex: (id) => `https://phemex.com/copy-trading/trader/${id}`,
  weex: (id) => `https://www.weex.com/copy-trading/trader/${id}`,
  xt: (id) => `https://www.xt.com/en/copy-trading/trader/${id}`,
  lbank: (id) => `https://www.lbank.com/copy-trading/trader/${id}`,
  bingx: (id) => `https://bingx.com/copy-trading/trader/${id}`,
  blofin: (id) => `https://blofin.com/copy-trading/trader/${id}`,
  bitmart: (id) => `https://www.bitmart.com/copy-trading/trader/${id}`,
  hyperliquid: (id) => `https://app.hyperliquid.xyz/explorer/address/${id}`,
  gmx: (id) => `https://app.gmx.io/#/actions/${id}`,
  dydx: (id) => `https://trade.dydx.exchange/portfolio/${id}`,
  gains: (id) => `https://gains.trade/portfolio/${id}`,
  binance_web3: (id) => `https://www.binance.com/en/web3/social-tracker/${id}`,
  binance_spot: (id) => `https://www.binance.com/en/copy-trading/lead-details/${id}`,
}

async function fetchAll(source, filter = {}) {
  let all = []
  let from = 0
  const PAGE = 1000
  while (true) {
    let q = supabase.from('trader_sources')
      .select('id, source, source_trader_id, market_type, profile_url')
      .eq('source', source)
    if (filter.nullField) q = q.is(filter.nullField, null)
    q = q.range(from, from + PAGE - 1)
    const { data } = await q
    if (!data?.length) break
    all = all.concat(data)
    from += PAGE
    if (data.length < PAGE) break
  }
  return all
}

async function main() {
  console.log(`\n📋 Fill Trader Profile Data ${DRY_RUN ? '(DRY RUN)' : ''}\n`)

  // ── Step 1: market_type ──
  console.log('=== 1. Market Type ===')
  for (const [source, marketType] of Object.entries(MARKET_TYPE_MAP)) {
    const { count } = await supabase.from('trader_sources')
      .select('id', { count: 'exact', head: true })
      .eq('source', source)
      .is('market_type', null)
    
    if (!count) continue

    if (!DRY_RUN) {
      await supabase.from('trader_sources')
        .update({ market_type: marketType })
        .eq('source', source)
        .is('market_type', null)
    }
    console.log(`  ${source}: ${count} → ${marketType}`)
  }

  // ── Step 2: profile_url ──
  console.log('\n=== 2. Profile URL ===')
  for (const [source, urlFn] of Object.entries(PROFILE_URL_MAP)) {
    const traders = await fetchAll(source, { nullField: 'profile_url' })
    if (!traders.length) continue

    let updated = 0
    for (const t of traders) {
      const url = urlFn(t.source_trader_id)
      if (!DRY_RUN) {
        const { error } = await supabase.from('trader_sources')
          .update({ profile_url: url })
          .eq('id', t.id)
        if (!error) updated++
      } else {
        updated++
      }
    }
    console.log(`  ${source}: ${updated}/${traders.length} profile URLs filled`)
  }

  // ── Step 3: tracked_since (in snapshots) ──
  console.log('\n=== 3. Tracked Since ===')
  {
    // Find snapshots without tracked_since
    const { count: missing } = await supabase.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .is('tracked_since', null)
    
    if (missing > 0) {
      console.log(`  ${missing} snapshots missing tracked_since`)
      
      // For each source+trader, find earliest captured_at
      if (!DRY_RUN) {
        // Use a SQL approach for efficiency — update tracked_since with the earliest captured_at per trader
        const { error } = await supabase.rpc('fill_tracked_since')
        if (error) {
          console.log(`  ⚠ RPC not available, doing manual update...`)
          
          // Get unique source+trader combos that need tracked_since
          const { data: distinct } = await supabase.from('trader_snapshots')
            .select('source, source_trader_id')
            .is('tracked_since', null)
            .limit(500)
          
          if (distinct) {
            const seen = new Set()
            let filled = 0
            for (const d of distinct) {
              const key = `${d.source}:${d.source_trader_id}`
              if (seen.has(key)) continue
              seen.add(key)
              
              // Find earliest captured_at
              const { data: earliest } = await supabase.from('trader_snapshots')
                .select('captured_at')
                .eq('source', d.source)
                .eq('source_trader_id', d.source_trader_id)
                .order('captured_at', { ascending: true })
                .limit(1)
                .maybeSingle()
              
              if (earliest) {
                await supabase.from('trader_snapshots')
                  .update({ tracked_since: earliest.captured_at })
                  .eq('source', d.source)
                  .eq('source_trader_id', d.source_trader_id)
                  .is('tracked_since', null)
                filled++
              }
            }
            console.log(`  ✅ ${filled} traders got tracked_since`)
          }
        } else {
          console.log(`  ✅ RPC fill_tracked_since completed`)
        }
      }
    } else {
      console.log('  ✅ All snapshots have tracked_since')
    }
  }

  // ── Final stats ──
  console.log('\n=== Final Stats ===')
  const fields = {
    market_type: 'trader_sources',
    profile_url: 'trader_sources',
    avatar_url: 'trader_sources',
  }
  for (const [field, table] of Object.entries(fields)) {
    const { count: total } = await supabase.from(table).select('id', { count: 'exact', head: true })
    const { count: filled } = await supabase.from(table).select('id', { count: 'exact', head: true }).not(field, 'is', null)
    console.log(`  ${field}: ${filled}/${total} (${Math.round(filled/total*100)}%)`)
  }
}

main().catch(console.error)
