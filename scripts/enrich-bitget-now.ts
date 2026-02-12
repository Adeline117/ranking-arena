/**
 * Standalone Bitget Futures enrichment script
 * Runs enrichment for bitget_futures traders using existing fetcher functions
 * 
 * Usage: npx tsx scripts/enrich-bitget-now.ts
 */

import 'dotenv/config'
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import {
  fetchBitgetEquityCurve,
  fetchBitgetStatsDetail,
  fetchBitgetPositionHistory,
  upsertEquityCurve,
  upsertStatsDetail,
  upsertPositionHistory,
} from '../lib/cron/fetchers/enrichment'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  // Get bitget_futures traders ordered by arena_score
  const { data: traders, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'bitget_futures')
    .order('arena_score', { ascending: false })
    .limit(100)

  if (error || !traders?.length) {
    console.error('Failed to get traders:', error?.message || 'no data')
    process.exit(1)
  }

  // Deduplicate
  const uniqueIds = [...new Set(traders.map(t => t.source_trader_id))]
  console.log(`Found ${uniqueIds.length} unique bitget_futures traders to enrich`)

  let enriched = 0, failed = 0

  for (const traderId of uniqueIds) {
    try {
      console.log(`[${enriched + failed + 1}/${uniqueIds.length}] Enriching ${traderId}...`)

      // Equity curve
      const curve = await fetchBitgetEquityCurve(traderId)
      if (curve.length > 0) {
        await upsertEquityCurve(supabase, 'bitget_futures', traderId, '90D', curve)
        console.log(`  ✅ Equity curve: ${curve.length} points`)
      } else {
        console.log(`  ⚠️  No equity curve data`)
      }

      // Position history
      const positions = await fetchBitgetPositionHistory(traderId)
      if (positions.length > 0) {
        await upsertPositionHistory(supabase, 'bitget_futures', traderId, positions)
        console.log(`  ✅ Positions: ${positions.length}`)
      } else {
        console.log(`  ⚠️  No position history`)
      }

      // Stats detail
      const stats = await fetchBitgetStatsDetail(traderId)
      if (stats) {
        await upsertStatsDetail(supabase, 'bitget_futures', traderId, '90D', stats)
        console.log(`  ✅ Stats saved`)
      } else {
        console.log(`  ⚠️  No stats data`)
      }

      enriched++
    } catch (err) {
      failed++
      console.error(`  ❌ Error: ${err instanceof Error ? err.message : err}`)
    }

    await sleep(2000) // Rate limit
  }

  console.log(`\n=== Done ===`)
  console.log(`Enriched: ${enriched}, Failed: ${failed}`)
}

main().catch(console.error)
