/**
 * Handle Enrichment Script
 * 
 * Fetches missing or 0x-address handles from each platform's API.
 * Updates trader_sources with human-readable nicknames.
 * 
 * Usage: node scripts/enrich-handles.mjs [--platform binance_futures]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url, options = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    ...options.headers,
  }
  try {
    const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(10000) })
    if (res.ok) return await res.json()
    // Try proxy fallback
    if (PROXY_URL) {
      const proxyRes = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
        ...options, headers, signal: AbortSignal.timeout(10000),
      })
      if (proxyRes.ok) return await proxyRes.json()
    }
    return null
  } catch {
    if (PROXY_URL) {
      try {
        const proxyRes = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
          ...options, headers, signal: AbortSignal.timeout(10000),
        })
        if (proxyRes.ok) return await proxyRes.json()
      } catch {}
    }
    return null
  }
}

// ============================================
// Platform-specific handle fetchers
// ============================================

async function fetchBinanceHandle(sourceId) {
  const data = await fetchJSON(
    `https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail?portfolioId=${sourceId}`
  )
  return data?.data?.nickName || data?.data?.nickname || null
}

async function fetchBybitHandle(sourceId) {
  const data = await fetchJSON(
    `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-detail?leaderId=${sourceId}`
  )
  return data?.result?.nickName || data?.result?.nickname || null
}

async function fetchBitgetHandle(sourceId) {
  const data = await fetchJSON(
    `https://www.bitget.com/v1/trigger/trace/public/traderDetail?traderId=${sourceId}`
  )
  return data?.data?.nickName || data?.data?.traderName || null
}

async function fetchOkxHandle(sourceId) {
  const data = await fetchJSON(
    `https://www.okx.com/api/v5/copytrading/public/lead-trader-detail?uniqueName=${sourceId}`
  )
  return data?.data?.[0]?.nickName || null
}

async function fetchMexcHandle(sourceId) {
  const data = await fetchJSON(
    `https://futures.mexc.com/api/v1/private/copytrading/trader/detail?traderId=${sourceId}`
  )
  return data?.data?.nickName || data?.data?.nickname || null
}

async function fetchKucoinHandle(sourceId) {
  const data = await fetchJSON(
    `https://www.kucoin.com/_api/copy-trade/leader/detail?leaderId=${sourceId}`
  )
  return data?.data?.nickName || data?.data?.name || null
}

async function fetchHtxHandle(sourceId) {
  const data = await fetchJSON(
    `https://www.htx.com/-/x/hbg/v1/copy/trade/leader/info?leaderUid=${sourceId}`
  )
  return data?.data?.nickName || data?.data?.userName || null
}

const PLATFORM_FETCHERS = {
  binance_futures: fetchBinanceHandle,
  binance_spot: fetchBinanceHandle,
  bybit: fetchBybitHandle,
  bitget_futures: fetchBitgetHandle,
  bitget_spot: fetchBitgetHandle,
  okx_futures: fetchOkxHandle,
  mexc: fetchMexcHandle,
  kucoin: fetchKucoinHandle,
  htx_futures: fetchHtxHandle,
}

// ============================================
// Main
// ============================================

async function enrichPlatform(platform) {
  const fetcher = PLATFORM_FETCHERS[platform]
  if (!fetcher) {
    console.log(`  ⚠️  No handle fetcher for ${platform}, skipping`)
    return 0
  }

  console.log(`\n📊 ${platform} - fetching missing handles...`)

  // Get traders with null handle or 0x address handle
  const { data: traders, error } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, handle')
    .eq('source', platform)
    .or('handle.is.null,handle.like.0x%')
    .limit(500)

  if (error) {
    console.error(`  DB error: ${error.message}`)
    return 0
  }

  console.log(`  Found ${traders?.length || 0} traders needing handles`)
  if (!traders?.length) return 0

  let updated = 0
  for (const trader of traders) {
    try {
      const handle = await fetcher(trader.source_trader_id)
      if (handle && handle !== trader.handle) {
        const { error: updateErr } = await supabase
          .from('trader_sources')
          .update({ handle })
          .eq('id', trader.id)

        if (!updateErr) {
          updated++
          if (updated <= 10) {
            console.log(`  ✅ ${trader.source_trader_id.slice(0, 12)}... → ${handle}`)
          }
        }
      }
      await sleep(300) // Rate limit
    } catch {}
  }

  console.log(`  ✅ Updated ${updated}/${traders.length} handles`)
  return updated
}

async function main() {
  const args = process.argv.slice(2)
  const platformIdx = args.indexOf('--platform')
  const targetPlatform = platformIdx >= 0 ? args[platformIdx + 1] : null

  const platforms = targetPlatform
    ? [targetPlatform]
    : Object.keys(PLATFORM_FETCHERS)

  let totalUpdated = 0
  for (const platform of platforms) {
    totalUpdated += await enrichPlatform(platform)
  }

  console.log(`\n📊 Total: ${totalUpdated} handles enriched`)
}

main().catch(console.error)
