/**
 * Enrich Binance Futures trader_snapshots with AUM
 * 
 * The detail API returns aumAmount per trader (not period-specific).
 * This script fetches each trader's detail and updates ALL season rows.
 * 
 * Usage: node scripts/import/enrich_binance_futures_aum.mjs [7D|30D|90D|ALL] [--concurrency=5]
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

const DETAIL_URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail'

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
}

async function fetchAum(traderId) {
  try {
    const url = `${DETAIL_URL}?portfolioId=${traderId}`
    const res = await fetch(url, { headers: DEFAULT_HEADERS, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    const json = await res.json()
    if (json.code !== '000000' || !json.data) return null
    const aum = parseFloat(json.data.aumAmount)
    return isNaN(aum) ? null : aum
  } catch {
    return null
  }
}

async function enrichPeriod(period, concurrency) {
  console.log(`\n=== Enriching ${SOURCE} ${period} AUM ===`)

  let missing = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id')
      .eq('source', SOURCE)
      .eq('season_id', period)
      .is('aum', null)
      .range(from, from + PAGE - 1)
    if (error) { console.error(`  Error: ${error.message}`); return 0 }
    missing = missing.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }

  console.log(`  Found ${missing.length} snapshots missing AUM`)
  if (!missing.length) return 0

  // Dedupe by source_trader_id (same trader in multiple periods)
  const uniqueTraders = [...new Map(missing.map(s => [s.source_trader_id, s])).values()]
  console.log(`  Unique traders to fetch: ${uniqueTraders.length}`)

  const limit = pLimit(concurrency)
  const aumCache = new Map()
  let fetched = 0
  let failed = 0
  const startTime = Date.now()

  // Fetch AUM for unique traders
  await Promise.all(
    uniqueTraders.map(snap =>
      limit(async () => {
        const aum = await fetchAum(snap.source_trader_id)
        fetched++
        if (aum !== null) {
          aumCache.set(snap.source_trader_id, aum)
        } else {
          failed++
        }
        if (fetched % 100 === 0 || fetched === uniqueTraders.length) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(`  Fetched: ${fetched}/${uniqueTraders.length} | cached: ${aumCache.size} | ${elapsed}s`)
        }
        if (fetched % 30 === 0) await sleep(300)
      })
    )
  )

  // Update all missing rows
  let updated = 0
  for (const snap of missing) {
    const aum = aumCache.get(snap.source_trader_id)
    if (aum == null) continue
    const { error } = await supabase
      .from('trader_snapshots')
      .update({ aum })
      .eq('id', snap.id)
    if (!error) updated++
  }

  console.log(`  ✅ Updated ${updated}/${missing.length} (${failed} fetch failures) for ${period}`)
  return updated
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  const concurrency = getConcurrency(5, 10)
  console.log('Binance Futures Enrichment (AUM)')
  console.log('Periods:', periods.join(', '))
  console.log('Concurrency:', concurrency)

  // Before
  for (const p of periods) {
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p)
    const { count: hasAum } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('aum', 'is', null)
    console.log(`  BEFORE ${p}: ${total} total, ${hasAum} have AUM`)
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
    const { count: hasAum } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('season_id', p).not('aum', 'is', null)
    console.log(`  AFTER ${p}: ${total} total, ${hasAum} have AUM`)
  }

  console.log(`\n🎉 Done. Total updated: ${totalUpdated}`)
}

main().catch(e => { console.error(e); process.exit(1) })
