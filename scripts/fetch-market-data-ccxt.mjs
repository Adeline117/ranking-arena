#!/usr/bin/env node
/**
 * fetch-market-data-ccxt.mjs
 * Replacement for fetch-market-data.mjs using ccxt unified interface.
 * Fetches Open Interest + ticker data from all supported exchanges.
 * Run via cron every hour.
 */
import ccxt from 'ccxt'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT', 'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'ARB/USDT', 'OP/USDT']

// Swap symbol variants for exchanges that need them
const SWAP_SYMBOLS = SYMBOLS.map(s => s.replace('/', ':').replace('USDT', 'USDT:USDT'))

const EXCHANGES = [
  'binance', 'bybit', 'okx', 'bitget', 'mexc',
  'kucoin', 'gateio', 'htx', 'coinex', 'bingx',
  'phemex', 'xt', 'lbank',
]

function createExchange(name) {
  const ExClass = ccxt[name]
  if (!ExClass) return null
  return new ExClass({
    enableRateLimit: true,
    timeout: 30000,
  })
}

async function fetchTickersForExchange(exchangeName) {
  const exchange = createExchange(exchangeName)
  if (!exchange) {
    console.warn(`⚠️ ccxt does not have class for: ${exchangeName}`)
    return []
  }

  const results = []
  try {
    await exchange.loadMarkets()
  } catch (e) {
    console.error(`❌ ${exchangeName} loadMarkets failed:`, e.message)
    return []
  }

  for (const symbol of SYMBOLS) {
    // Try both spot and swap variants
    const candidates = [symbol]
    const swapVariant = `${symbol}:USDT`
    if (exchange.markets[swapVariant]) candidates.unshift(swapVariant)

    for (const sym of candidates) {
      if (!exchange.markets[sym]) continue
      try {
        const ticker = await exchange.fetchTicker(sym)
        const row = {
          platform: exchangeName,
          symbol: symbol.replace('/', ''),
          price: ticker.last,
          volume_24h: ticker.quoteVolume || ticker.baseVolume * (ticker.last || 0),
          high_24h: ticker.high,
          low_24h: ticker.low,
          change_24h_pct: ticker.percentage,
          timestamp: new Date().toISOString(),
        }

        // Try open interest if it's a swap/futures market
        if (exchange.markets[sym]?.swap || exchange.markets[sym]?.future) {
          try {
            if (typeof exchange.fetchOpenInterest === 'function') {
              const oi = await exchange.fetchOpenInterest(sym)
              row.open_interest_usd = oi?.openInterestValue || oi?.openInterestAmount * (ticker.last || 0)
              row.open_interest_contracts = oi?.openInterestAmount
            }
          } catch { /* OI not available for this pair */ }
        }

        results.push(row)
        break // got data, skip other candidates
      } catch {
        continue
      }
    }
    await sleep(100)
  }

  return results
}

async function main() {
  console.log(`🚀 Fetching market data via ccxt from ${EXCHANGES.length} exchanges...`)
  const allResults = []

  for (const ex of EXCHANGES) {
    console.log(`📊 ${ex}...`)
    try {
      const rows = await fetchTickersForExchange(ex)
      console.log(`  ✅ ${ex}: ${rows.length} symbols`)
      allResults.push(...rows)
    } catch (e) {
      console.error(`  ❌ ${ex}: ${e.message}`)
    }
  }

  console.log(`\n📈 Total: ${allResults.length} data points`)

  // Upsert ticker data
  if (allResults.length > 0) {
    const tickerRows = allResults.map(r => ({
      platform: r.platform,
      symbol: r.symbol,
      price: r.price,
      volume_24h: r.volume_24h,
      high_24h: r.high_24h,
      low_24h: r.low_24h,
      change_24h_pct: r.change_24h_pct,
      timestamp: r.timestamp,
    }))

    const { error: tickerErr } = await supabase
      .from('market_tickers')
      .upsert(tickerRows, { onConflict: 'platform,symbol' })
    if (tickerErr) console.error('Ticker upsert error:', tickerErr.message)
    else console.log(`✅ Upserted ${tickerRows.length} tickers`)

    // Upsert OI data
    const oiRows = allResults
      .filter(r => r.open_interest_usd != null)
      .map(r => ({
        platform: r.platform,
        symbol: r.symbol,
        open_interest_usd: r.open_interest_usd,
        open_interest_contracts: r.open_interest_contracts,
        timestamp: r.timestamp,
      }))

    if (oiRows.length > 0) {
      const { error: oiErr } = await supabase
        .from('open_interest')
        .upsert(oiRows, { onConflict: 'platform,symbol' })
      if (oiErr) console.error('OI upsert error:', oiErr.message)
      else console.log(`✅ Upserted ${oiRows.length} OI records`)
    }
  }

  console.log('✅ Done')
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
