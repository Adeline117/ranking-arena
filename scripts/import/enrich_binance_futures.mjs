/**
 * Enrich Binance Futures trader_snapshots with trades_count
 * 
 * The futures detail API returns totalOrder but the import wasn't saving it.
 * This script batch-fetches detail data and UPDATEs existing rows.
 * 
 * NOTE: Binance futures API is geo-blocked in the US. Run from VPS or Asian server.
 * 
 * Usage: node scripts/import/enrich_binance_futures.mjs [7D|30D|90D|ALL] [--concurrency=5]
 */

import pLimit from 'p-limit'
import {
  getSupabaseClient,
  sleep,
  getTargetPeriods,
  getConcurrency,
} from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'binance_futures'

const API_BASE = 'https://www.binance.com'
const DETAIL_API = `${API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance`
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Origin': 'https://www.binance.com',
  'Referer': 'https://www.binance.com/zh-CN/copy-trading',
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

async function fetchTraderDetail(traderId, period) {
  try {
    const url = `${DETAIL_API}?portfolioId=${traderId}&timeRange=${period}`
    const response = await proxyFetch(url, { headers: DEFAULT_HEADERS })
    if (!response.ok) return null
    const data = await response.json()
    if (data.code !== '000000' || !data.data) return null
    return {
      totalTrades: parseInt(data.data.totalOrder ?? 0),
      winRate: parseFloat(data.data.winRate ?? 0),
      maxDrawdown: parseFloat(data.data.mdd ?? 0),
    }
  } catch {
    return null
  }
}

async function enrichPeriod(period, concurrency) {
  console.log(`\n=== Enriching ${SOURCE} ${period} ===`)

  // Get snapshots missing trades_count (paginate past 1000 limit)
  let missing = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error: fetchErr } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id')
      .eq('source', SOURCE)
      .eq('season_id', period)
      .is('trades_count', null)
      .range(from, from + PAGE - 1)
    if (fetchErr) { console.error(`  Error: ${fetchErr.message}`); return 0 }
    missing = missing.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  const error = null

  if (error) {
    console.error(`  Error: ${error.message}`)
    return 0
  }

  console.log(`  Found ${missing.length} snapshots missing trades_count`)
  if (!missing.length) return 0

  const limit = pLimit(concurrency)
  let updated = 0
  let failed = 0
  let completed = 0
  const startTime = Date.now()

  await Promise.all(
    missing.map(snap =>
      limit(async () => {
        const detail = await fetchTraderDetail(snap.source_trader_id, period)
        completed++

        if (detail && detail.totalTrades > 0) {
          const { error: updateErr } = await supabase
            .from('trader_snapshots')
            .update({ trades_count: detail.totalTrades })
            .eq('id', snap.id)

          if (!updateErr) updated++
          else failed++
        } else {
          failed++
        }

        if (completed % 50 === 0 || completed === missing.length) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(`  Progress: ${completed}/${missing.length} | updated: ${updated} | ${elapsed}s`)
        }

        // Rate limiting
        if (completed % 20 === 0) await sleep(200)
      })
    )
  )

  console.log(`  ✅ Updated ${updated}/${missing.length} (${failed} failed) for ${period}`)
  return updated
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  const concurrency = getConcurrency(5, 10)
  console.log('Binance Futures Enrichment (trades_count)')
  console.log('Periods:', periods.join(', '))
  console.log('Concurrency:', concurrency)

  // Before
  for (const p of periods) {
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p)
    const { count: hasTc } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('trades_count', 'is', null)
    console.log(`  BEFORE ${p}: ${total} total, ${hasTc} trades_count`)
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
    const { count: hasTc } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('trades_count', 'is', null)
    console.log(`  AFTER ${p}: ${total} total, ${hasTc} trades_count`)
  }

  console.log(`\n🎉 Done. Total updated: ${totalUpdated}`)
}

main().catch(e => { console.error(e); process.exit(1) })
