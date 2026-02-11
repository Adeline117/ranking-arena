/**
 * Enrich Binance Spot trader_snapshots with win_rate and trades_count
 * 
 * Uses the spot-copy-trade detail API to fetch missing data.
 * 
 * NOTE: Binance API is geo-blocked in the US. Run from VPS or Asian server.
 * 
 * Usage: node scripts/import/enrich_binance_spot.mjs [7D|30D|90D|ALL] [--concurrency=5]
 */

import pLimit from 'p-limit'
import {
  getSupabaseClient,
  sleep,
  getTargetPeriods,
  getConcurrency,
} from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'binance_spot'
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL

const PERIOD_TO_API = { '7D': 'WEEKLY', '30D': 'MONTHLY', '90D': 'QUARTERLY' }

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Origin': 'https://www.binance.com',
  'Referer': 'https://www.binance.com/zh-CN/copy-trading/spot',
}

async function proxyFetch(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) })
    if (res.ok || !PROXY_URL) return res
    if (res.status === 451 || res.status === 403) {
      return await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
        ...options, signal: AbortSignal.timeout(15000)
      })
    }
    return res
  } catch (e) {
    if (PROXY_URL) {
      return await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
        ...options, signal: AbortSignal.timeout(15000)
      })
    }
    throw e
  }
}

async function fetchSpotDetail(traderId, period) {
  const apiPeriod = PERIOD_TO_API[period] || 'QUARTERLY'
  
  // Try new spot endpoint first
  const endpoints = [
    { url: 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/lead-portfolio/performance', body: { portfolioId: traderId, timeRange: apiPeriod } },
    { url: 'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance', body: { portfolioId: traderId, timeRange: apiPeriod, portfolioType: 'SPOT' } },
  ]

  for (const ep of endpoints) {
    try {
      const res = await proxyFetch(ep.url, {
        method: 'POST',
        headers: DEFAULT_HEADERS,
        body: JSON.stringify(ep.body),
      })
      if (!res.ok) continue
      const json = await res.json()
      const d = json.data || json
      if (!d) continue

      return {
        winRate: d.winRate != null ? parseFloat(d.winRate) : null,
        maxDrawdown: d.mdd != null ? Math.abs(parseFloat(d.mdd)) : (d.maxDrawdown != null ? Math.abs(parseFloat(d.maxDrawdown)) : null),
        totalTrades: d.totalOrder != null ? parseInt(d.totalOrder) : (d.totalTrades != null ? parseInt(d.totalTrades) : null),
      }
    } catch {
      continue
    }
  }
  return null
}

async function enrichPeriod(period, concurrency) {
  console.log(`\n=== Enriching ${SOURCE} ${period} ===`)

  // Get snapshots missing win_rate OR trades_count
  const { data: missing, error } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, win_rate, trades_count')
    .eq('source', SOURCE)
    .eq('season_id', period)
    .or('win_rate.is.null,trades_count.is.null')

  if (error) {
    console.error(`  Error: ${error.message}`)
    return 0
  }

  console.log(`  Found ${missing.length} snapshots needing enrichment`)
  if (!missing.length) return 0

  const limit = pLimit(concurrency)
  let updated = 0
  let completed = 0
  const startTime = Date.now()

  await Promise.all(
    missing.map(snap =>
      limit(async () => {
        const detail = await fetchSpotDetail(snap.source_trader_id, period)
        completed++

        if (detail) {
          const updates = {}
          if (snap.win_rate == null && detail.winRate != null) {
            updates.win_rate = detail.winRate <= 1 ? detail.winRate * 100 : detail.winRate
          }
          if (snap.trades_count == null && detail.totalTrades != null && detail.totalTrades > 0) {
            updates.trades_count = detail.totalTrades
          }

          if (Object.keys(updates).length > 0) {
            const { error: updateErr } = await supabase
              .from('trader_snapshots')
              .update(updates)
              .eq('id', snap.id)
            if (!updateErr) updated++
          }
        }

        if (completed % 50 === 0 || completed === missing.length) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(`  Progress: ${completed}/${missing.length} | updated: ${updated} | ${elapsed}s`)
        }

        if (completed % 20 === 0) await sleep(200)
      })
    )
  )

  console.log(`  ✅ Updated ${updated}/${missing.length} for ${period}`)
  return updated
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  const concurrency = getConcurrency(5, 10)
  console.log('Binance Spot Enrichment (win_rate, trades_count)')
  console.log('Periods:', periods.join(', '))

  // Before
  for (const p of periods) {
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p)
    const { count: hasWr } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('win_rate', 'is', null)
    const { count: hasTc } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('trades_count', 'is', null)
    console.log(`  BEFORE ${p}: ${total} total, ${hasWr} win_rate, ${hasTc} trades_count`)
  }

  let totalUpdated = 0
  for (const p of periods) {
    totalUpdated += await enrichPeriod(p, concurrency)
    await sleep(1000)
  }

  // After
  console.log('\n--- AFTER ---')
  for (const p of periods) {
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p)
    const { count: hasWr } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('win_rate', 'is', null)
    const { count: hasTc } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('trades_count', 'is', null)
    console.log(`  AFTER ${p}: ${total} total, ${hasWr} win_rate, ${hasTc} trades_count`)
  }

  console.log(`\n🎉 Done. Total updated: ${totalUpdated}`)
}

main().catch(e => { console.error(e); process.exit(1) })
