#!/usr/bin/env node
/**
 * import_ccxt_unified.mjs
 * Unified market data import using ccxt.
 * 
 * This script does NOT replace copy trading leaderboard imports (ccxt doesn't support those APIs).
 * Instead it provides:
 *   1. Unified price data for PnL calculations
 *   2. Trading pair metadata (market info)
 *   3. OHLCV data for equity curve approximation
 *   4. Open interest data
 * 
 * Usage:
 *   node scripts/import/import_ccxt_unified.mjs                    # all exchanges
 *   node scripts/import/import_ccxt_unified.mjs --exchange binance  # single exchange
 *   node scripts/import/import_ccxt_unified.mjs --symbols BTC/USDT,ETH/USDT
 *   node scripts/import/import_ccxt_unified.mjs --ohlcv             # also fetch OHLCV
 */
import ccxt from 'ccxt'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Parse CLI args
const args = process.argv.slice(2)
function getArg(name) {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}
const hasFlag = name => args.includes(`--${name}`)

const EXCHANGES = [
  'binance', 'bybit', 'okx', 'bitget', 'mexc',
  'kucoin', 'gateio', 'htx', 'coinex', 'bingx',
  'phemex', 'xt', 'lbank',
]

const DEFAULT_SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT',
  'DOGE/USDT', 'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT',
  'ARB/USDT', 'OP/USDT', 'MATIC/USDT', 'UNI/USDT', 'AAVE/USDT',
  'SUI/USDT', 'APT/USDT', 'SEI/USDT', 'TIA/USDT', 'JUP/USDT',
]

const targetExchange = getArg('exchange')
const targetSymbols = getArg('symbols')?.split(',') || DEFAULT_SYMBOLS
const fetchOhlcv = hasFlag('ohlcv')

const exchanges = targetExchange ? [targetExchange] : EXCHANGES

function createExchange(name) {
  const ExClass = ccxt[name]
  if (!ExClass) return null
  return new ExClass({ enableRateLimit: true, timeout: 30000 })
}

// ===== 1. Fetch & store prices =====
async function importPrices(exchangeName) {
  const exchange = createExchange(exchangeName)
  if (!exchange) return 0

  try {
    await exchange.loadMarkets()
  } catch (e) {
    console.error(`  ❌ loadMarkets: ${e.message}`)
    return 0
  }

  const rows = []
  for (const symbol of targetSymbols) {
    if (!exchange.markets[symbol]) continue
    try {
      const ticker = await exchange.fetchTicker(symbol)
      rows.push({
        platform: exchangeName,
        symbol: symbol.replace('/', ''),
        price: ticker.last,
        bid: ticker.bid,
        ask: ticker.ask,
        volume_24h: ticker.quoteVolume,
        high_24h: ticker.high,
        low_24h: ticker.low,
        change_24h_pct: ticker.percentage,
        timestamp: new Date().toISOString(),
      })
    } catch { /* skip */ }
    await sleep(80)
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from('market_tickers')
      .upsert(rows, { onConflict: 'platform,symbol' })
    if (error) console.error(`  DB error: ${error.message}`)
  }

  return rows.length
}

// ===== 2. Fetch & store market metadata =====
async function importMarkets(exchangeName) {
  const exchange = createExchange(exchangeName)
  if (!exchange) return 0

  try {
    const markets = await exchange.loadMarkets()
    const rows = Object.values(markets)
      .filter(m => m.quote === 'USDT' && m.active)
      .map(m => ({
        platform: exchangeName,
        symbol: m.symbol?.replace('/', '') || m.id,
        base: m.base,
        quote: m.quote,
        type: m.type, // spot, swap, future
        contract_size: m.contractSize,
        tick_size: m.precision?.price,
        min_amount: m.limits?.amount?.min,
        is_active: m.active,
        updated_at: new Date().toISOString(),
      }))

    if (rows.length > 0) {
      const { error } = await supabase
        .from('exchange_markets')
        .upsert(rows, { onConflict: 'platform,symbol' })
      if (error && !error.message.includes('does not exist')) {
        console.error(`  Markets DB error: ${error.message}`)
      }
    }
    return rows.length
  } catch (e) {
    console.error(`  ❌ markets: ${e.message}`)
    return 0
  }
}

// ===== 3. Fetch OHLCV for equity curve data =====
async function importOHLCV(exchangeName) {
  if (!fetchOhlcv) return 0
  const exchange = createExchange(exchangeName)
  if (!exchange) return 0

  try {
    await exchange.loadMarkets()
  } catch { return 0 }

  let count = 0
  for (const symbol of targetSymbols.slice(0, 5)) { // Limit to top 5 for OHLCV
    if (!exchange.markets[symbol]) continue
    try {
      const candles = await exchange.fetchOHLCV(symbol, '1d', undefined, 30) // Last 30 days
      const rows = candles.map(([ts, o, h, l, c, v]) => ({
        platform: exchangeName,
        symbol: symbol.replace('/', ''),
        timestamp: new Date(ts).toISOString(),
        open: o, high: h, low: l, close: c, volume: v,
      }))

      if (rows.length > 0) {
        const { error } = await supabase
          .from('ohlcv_daily')
          .upsert(rows, { onConflict: 'platform,symbol,timestamp' })
        if (error && !error.message.includes('does not exist')) {
          console.error(`  OHLCV DB error: ${error.message}`)
        }
        count += rows.length
      }
    } catch { /* skip */ }
    await sleep(200)
  }
  return count
}

// ===== Main =====
async function main() {
  console.log(`🚀 CCXT Unified Import`)
  console.log(`   Exchanges: ${exchanges.join(', ')}`)
  console.log(`   Symbols: ${targetSymbols.length}`)
  console.log(`   OHLCV: ${fetchOhlcv ? 'yes' : 'no'}`)
  console.log()

  for (const ex of exchanges) {
    console.log(`📊 ${ex}...`)
    const prices = await importPrices(ex)
    const markets = await importMarkets(ex)
    const ohlcv = await importOHLCV(ex)
    console.log(`  ✅ prices=${prices} markets=${markets}${fetchOhlcv ? ` ohlcv=${ohlcv}` : ''}`)
  }

  console.log('\n✅ All done')
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
