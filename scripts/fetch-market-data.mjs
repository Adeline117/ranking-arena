#!/usr/bin/env node
/**
 * Fetch Open Interest + Liquidation data from exchanges
 * Stores to Supabase: open_interest, liquidations tables
 * Run via cron every hour
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'ARB', 'OP']

// ============ Binance ============
async function fetchBinanceOI() {
  const results = []
  for (const sym of SYMBOLS) {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}USDT`)
      if (!res.ok) continue
      const data = await res.json()
      // Binance returns OI in contracts (base asset)
      const oiContracts = parseFloat(data.openInterest)
      
      // Get price for USD conversion
      const priceRes = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}USDT`)
      const priceData = await priceRes.json()
      const price = parseFloat(priceData.price)
      
      results.push({
        platform: 'binance',
        symbol: `${sym}USDT`,
        open_interest_usd: Math.round(oiContracts * price * 100) / 100,
        open_interest_contracts: oiContracts,
        timestamp: new Date().toISOString()
      })
      await sleep(200)
    } catch (e) { console.error(`Binance ${sym}:`, e.message) }
  }
  return results
}

// ============ Bybit ============
async function fetchBybitOI() {
  const results = []
  for (const sym of SYMBOLS) {
    try {
      const res = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}USDT`)
      if (!res.ok) continue
      const data = await res.json()
      const item = data?.result?.list?.[0]
      if (!item) continue
      
      const oiValue = parseFloat(item.openInterestValue || 0) // Already in USD
      const oiContracts = parseFloat(item.openInterest || 0)
      
      results.push({
        platform: 'bybit',
        symbol: `${sym}USDT`,
        open_interest_usd: oiValue,
        open_interest_contracts: oiContracts,
        timestamp: new Date().toISOString()
      })
      await sleep(200)
    } catch (e) { console.error(`Bybit ${sym}:`, e.message) }
  }
  return results
}

// ============ OKX ============
async function fetchOkxOI() {
  const results = []
  for (const sym of SYMBOLS) {
    try {
      const res = await fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${sym}-USDT-SWAP`)
      if (!res.ok) continue
      const data = await res.json()
      const item = data?.data?.[0]
      if (!item) continue
      
      const oiContracts = parseFloat(item.oi || 0)
      const oiUsd = parseFloat(item.oiCcy || 0) // OKX gives OI in coin, need price
      
      // Get price
      const priceRes = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${sym}-USDT-SWAP`)
      const priceData = await priceRes.json()
      const price = parseFloat(priceData?.data?.[0]?.last || 0)
      
      results.push({
        platform: 'okx',
        symbol: `${sym}-USDT-SWAP`,
        open_interest_usd: Math.round(oiUsd * price * 100) / 100,
        open_interest_contracts: oiContracts,
        timestamp: new Date().toISOString()
      })
      await sleep(200)
    } catch (e) { console.error(`OKX ${sym}:`, e.message) }
  }
  return results
}

// ============ Binance Liquidations (24h) ============
async function fetchBinanceLiquidations() {
  try {
    // Binance doesn't have a public liquidation endpoint anymore
    // Use forceOrders endpoint
    const results = []
    for (const sym of ['BTC', 'ETH', 'SOL']) {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/forceOrders?symbol=${sym}USDT&limit=100`)
      if (!res.ok) continue
      const data = await res.json()
      
      let longVol = 0, shortVol = 0, longCount = 0, shortCount = 0
      for (const order of (data || [])) {
        const qty = parseFloat(order.origQty) * parseFloat(order.price)
        if (order.side === 'SELL') { longVol += qty; longCount++ }
        else { shortVol += qty; shortCount++ }
      }
      
      results.push({
        platform: 'binance',
        symbol: `${sym}USDT`,
        long_volume: longVol,
        short_volume: shortVol,
        long_count: longCount,
        short_count: shortCount,
        total_volume: longVol + shortVol,
        period: '24h',
        timestamp: new Date().toISOString()
      })
      await sleep(300)
    }
    return results
  } catch (e) {
    console.error('Binance liquidations:', e.message)
    return []
  }
}

// ============ Main ============
async function main() {
  console.log(`[${new Date().toISOString()}] Fetching market data...`)
  
  // Fetch OI from all exchanges
  const [binanceOI, bybitOI, okxOI] = await Promise.all([
    fetchBinanceOI(),
    fetchBybitOI(),
    fetchOkxOI()
  ])
  
  const allOI = [...binanceOI, ...bybitOI, ...okxOI]
  console.log(`OI: Binance ${binanceOI.length}, Bybit ${bybitOI.length}, OKX ${okxOI.length}`)
  
  if (allOI.length > 0) {
    const { error } = await supabase.from('open_interest').upsert(allOI, {
      onConflict: 'platform,symbol,timestamp',
      ignoreDuplicates: true
    })
    if (error) {
      // Try insert instead
      for (const item of allOI) {
        await supabase.from('open_interest').insert(item).catch(() => {})
      }
    }
    console.log(`Saved ${allOI.length} OI records`)
  }
  
  // Fetch liquidations
  const liqData = await fetchBinanceLiquidations()
  if (liqData.length > 0) {
    for (const liq of liqData) {
      await supabase.from('liquidations').insert(liq).catch(e => {
        console.error('Liq insert error:', e.message)
      })
    }
    console.log(`Saved ${liqData.length} liquidation records`)
  }
  
  // Log summary
  const btcOI = allOI.filter(o => o.symbol.includes('BTC'))
  if (btcOI.length > 0) {
    const totalBtcOI = btcOI.reduce((sum, o) => sum + o.open_interest_usd, 0)
    console.log(`BTC Total OI: $${(totalBtcOI / 1e9).toFixed(2)}B across ${btcOI.length} exchanges`)
  }
  
  console.log('Done.')
}

main().catch(console.error)
