#!/usr/bin/env npx tsx
/**
 * Backfill position history for top traders on platforms that support it.
 *
 * The enrichment pipeline has position history code but per-platform timeouts
 * cause it to skip top-ranked traders. This script fills the gap.
 *
 * Usage:
 *   npx tsx scripts/backfill-positions.ts                      # all platforms
 *   npx tsx scripts/backfill-positions.ts --platform=hyperliquid  # single platform
 *   npx tsx scripts/backfill-positions.ts --limit=50              # top 50 per platform
 *   npx tsx scripts/backfill-positions.ts --dry-run               # check missing only
 */

import 'dotenv/config'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  ENRICHMENT_PLATFORM_CONFIGS,
  type EnrichmentResult,
} from '@/lib/cron/enrichment-runner'
import {
  upsertPositionHistory,
  upsertAssetBreakdown,
  upsertPortfolio,
  calculateAssetBreakdown,
  type PositionHistoryItem,
  type PortfolioPosition,
} from '@/lib/cron/fetchers/enrichment'

// ─── Config ──────────────────────────────────────────────────

const CONCURRENCY = 2
const DELAY_BETWEEN_BATCHES_MS = 2000
const DEFAULT_LIMIT = 100

// Parse CLI args
const args = process.argv.slice(2)
const platformFlag = args.find(a => a.startsWith('--platform='))?.split('=')[1]
const limitFlag = args.find(a => a.startsWith('--limit='))?.split('=')[1]
const dryRun = args.includes('--dry-run')
const traderLimit = limitFlag ? parseInt(limitFlag, 10) : DEFAULT_LIMIT

// ─── Supabase client ─────────────────────────────────────────

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
})

// ─── Platforms with fetchPositionHistory ──────────────────────

function getPlatformsWithPositions(): string[] {
  return Object.entries(ENRICHMENT_PLATFORM_CONFIGS)
    .filter(([, config]) => config.fetchPositionHistory != null || config.fetchCurrentPositions != null)
    .map(([key]) => key)
}

// ─── Find traders missing position history ───────────────────

async function findTradersMissingPositions(
  supabase: SupabaseClient,
  platform: string,
  limit: number
): Promise<string[]> {
  // Get top traders from leaderboard_ranks (90D season, by arena_score)
  const { data: topTraders, error: topError } = await supabase
    .from('leaderboard_ranks')
    .select('source_trader_id')
    .eq('source', platform)
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .order('arena_score', { ascending: false })
    .limit(limit)

  if (topError || !topTraders || topTraders.length === 0) {
    console.log(`  No traders found in leaderboard_ranks for ${platform}`)
    return []
  }

  const traderIds = topTraders.map((t: { source_trader_id: string }) => t.source_trader_id)

  // Check which ones have position history
  const { data: withPositions, error: posError } = await supabase
    .from('trader_position_history')
    .select('source_trader_id')
    .eq('source', platform)
    .in('source_trader_id', traderIds)

  if (posError) {
    console.log(`  Error checking position history: ${posError.message}`)
    return traderIds // assume all missing
  }

  const hasPositions = new Set((withPositions || []).map((r: { source_trader_id: string }) => r.source_trader_id))
  return traderIds.filter(id => !hasPositions.has(id))
}

// ─── Sleep utility ───────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const allPlatforms = getPlatformsWithPositions()
  const platforms = platformFlag
    ? allPlatforms.filter(p => p === platformFlag)
    : allPlatforms

  if (platforms.length === 0) {
    console.error(
      platformFlag
        ? `Platform "${platformFlag}" not found or has no position fetcher. Available: ${allPlatforms.join(', ')}`
        : 'No platforms with position fetchers found'
    )
    process.exit(1)
  }

  console.log(`\n=== Position History Backfill ===`)
  console.log(`Platforms: ${platforms.join(', ')}`)
  console.log(`Limit: top ${traderLimit} traders per platform`)
  console.log(`Concurrency: ${CONCURRENCY} traders at a time`)
  if (dryRun) console.log(`DRY RUN: will only check missing traders, not fetch\n`)
  else console.log('')

  let grandTotalPositions = 0
  let grandTotalTraders = 0

  for (const platform of platforms) {
    const config = ENRICHMENT_PLATFORM_CONFIGS[platform]
    if (!config?.fetchPositionHistory && !config?.fetchCurrentPositions) continue

    const isPortfolioOnly = !config.fetchPositionHistory && !!config.fetchCurrentPositions
    const modeLabel = isPortfolioOnly ? 'current positions (portfolio)' : 'position history'

    console.log(`\n--- ${platform} (${modeLabel}) ---`)

    // Find traders missing position history
    const missingTraders = await findTradersMissingPositions(supabase, platform, traderLimit)
    console.log(`  ${missingTraders.length} traders missing ${modeLabel} (out of top ${traderLimit})`)

    if (missingTraders.length === 0 || dryRun) continue

    let backfilled = 0
    let totalPositions = 0
    let failed = 0

    for (let i = 0; i < missingTraders.length; i += CONCURRENCY) {
      const batch = missingTraders.slice(i, i + CONCURRENCY)

      const results = await Promise.allSettled(
        batch.map(async (traderId) => {
          try {
            // Portfolio-only mode: fetch current positions and save as portfolio
            if (isPortfolioOnly) {
              const currentPos = await config.fetchCurrentPositions!(traderId)
              if (currentPos.length === 0) return { traderId, count: 0 }

              await upsertPortfolio(supabase, platform, traderId,
                currentPos.map((p) => ({
                  symbol: p.symbol,
                  direction: p.direction,
                  investedPct: 'investedPct' in p ? p.investedPct : null,
                  entryPrice: p.entryPrice,
                  pnl: 'pnl' in p ? p.pnl : null,
                }))
              )
              return { traderId, count: currentPos.length }
            }

            // Standard mode: fetch position history
            const positions = await config.fetchPositionHistory!(traderId)
            if (positions.length === 0) {
              return { traderId, count: 0 }
            }

            // Save position history
            const { saved, error } = await upsertPositionHistory(
              supabase,
              platform,
              traderId,
              positions
            )

            if (error) {
              console.error(`  [${traderId}] upsert error: ${error}`)
              return { traderId, count: 0 }
            }

            // Also compute and save asset breakdown (non-critical, may fail if no unique constraint)
            try {
              const breakdown = calculateAssetBreakdown(positions)
              if (breakdown.length > 0) {
                await upsertAssetBreakdown(supabase, platform, traderId, '90D', breakdown)
              }
            } catch {
              // Asset breakdown is optional, position history is the primary goal
            }

            return { traderId, count: saved }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`  [${traderId}] error: ${msg}`)
            throw err
          }
        })
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { count } = result.value
          if (count > 0) {
            backfilled++
            totalPositions += count
          }
        } else {
          failed++
        }
      }

      // Progress log
      const processed = Math.min(i + CONCURRENCY, missingTraders.length)
      console.log(
        `  ${platform}: ${processed}/${missingTraders.length} traders processed, ` +
        `${backfilled} backfilled, ${totalPositions} positions saved, ${failed} failed`
      )

      // Delay between batches (skip after last batch)
      if (i + CONCURRENCY < missingTraders.length) {
        await sleep(DELAY_BETWEEN_BATCHES_MS)
      }
    }

    console.log(
      `  ${platform}: DONE — ${backfilled}/${missingTraders.length} traders backfilled, ` +
      `${totalPositions} positions saved, ${failed} failed`
    )

    grandTotalTraders += backfilled
    grandTotalPositions += totalPositions
  }

  console.log(`\n=== Summary ===`)
  console.log(`Total traders backfilled: ${grandTotalTraders}`)
  console.log(`Total positions saved: ${grandTotalPositions}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
