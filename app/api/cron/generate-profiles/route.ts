/**
 * POST /api/cron/generate-profiles
 *
 * Auto-generates bio and tags for traders that have empty bio or bio_source='auto'.
 * Runs after batch-fetch to fill empty profiles. Never overwrites manual or exchange bios.
 *
 * Query params:
 *   limit  - max traders to process per run (default 500)
 *   force  - if 'true', regenerate all auto bios (not just empty ones)
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { generateAutoBio, generateAutoTags, type AutoProfileInput } from '@/lib/utils/auto-profile'
import { safeParseInt } from '@/lib/utils/safe-parse'
import { logger } from '@/lib/logger'
import { withCron } from '@/lib/api/with-cron'
import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import {
  filterPublicRankingSources,
  isPublicRankingSourceAllowed,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const PROFILE_RANKING_SOURCES = Object.freeze(
  filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)
)
const PROFILE_PERIODS = ['90D', '30D', '7D'] as const

function rankIdentity(source: string, traderKey: string): string {
  return `${source}\u0000${traderKey}`
}

const handler = withCron('generate-profiles', async (request: NextRequest) => {
  const url = new URL(request.url)
  const limit = Math.min(Math.max(safeParseInt(url.searchParams.get('limit'), 500), 1), 2000)
  const force = url.searchParams.get('force') === 'true'

  const supabase = getSupabaseAdmin()

  // Step 1: Find traders that need auto-generated profiles
  let query = supabase
    .from('trader_profiles_v2')
    .select('platform, market_type, trader_key, display_name, bio, bio_source')
    .in('platform', PROFILE_RANKING_SOURCES)
    .order('updated_at', { ascending: false })
    .order('platform', { ascending: true })
    .order('trader_key', { ascending: true })
    .limit(limit)

  if (force) {
    query = query.or('bio_source.is.null,bio_source.eq.auto')
  } else {
    query = query.is('bio_source', null)
  }

  const { data: profiles, error: fetchErr } = await query

  if (fetchErr) {
    throw new Error(`Failed to fetch profiles: ${fetchErr.message}`)
  }

  if (!profiles || profiles.length === 0) {
    return { count: 0, message: 'No profiles need generation' }
  }

  logger.warn(`[generate-profiles] Processing ${profiles.length} traders`)

  const uniquePlatforms = [...new Set(profiles.map((profile) => profile.platform))]

  // Step 2: Process each trader
  let generated = 0
  let skipped = 0
  let errors = 0

  const BATCH_SIZE = 50
  for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
    const batch = profiles.slice(i, i + BATCH_SIZE)

    const idsBySource = new Map<string, Set<string>>()
    for (const profile of batch) {
      if (!isPublicRankingSourceAllowed(profile.platform)) {
        throw new Error(`Profile generation crossed public source boundary: ${profile.platform}`)
      }
      const ids = idsBySource.get(profile.platform) ?? new Set<string>()
      ids.add(profile.trader_key)
      idsBySource.set(profile.platform, ids)
    }
    const batchSources = [...idsBySource.keys()].sort()

    // Each period has its own publication. Exact per-source identity queries
    // prevent equal trader IDs on different exchanges from borrowing metrics.
    const periodReads = await Promise.all(
      PROFILE_PERIODS.map((period) =>
        readSealedRankingGeneration(
          supabase,
          { season: period, sources: batchSources },
          async (publication) => {
            const rows = await Promise.all(
              [...idsBySource.entries()].map(async ([source, ids]) => {
                const { data, error } = await supabase
                  .from('leaderboard_ranks')
                  .select(
                    'source_trader_id, source, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, sharpe_ratio, arena_score, rank'
                  )
                  .eq('source', source)
                  .in('source_trader_id', [...ids])
                  .eq('season_id', period)
                  .filter('rank_publication_id', 'eq', publication.scoreCohortId)
                  .order('source_trader_id', { ascending: true })

                if (error || data === null) {
                  throw new Error(
                    `Profile rank query failed for ${source}/${period}: ${error?.message ?? 'null payload'}`
                  )
                }
                if (
                  data.some(
                    (row) =>
                      row.source !== source ||
                      !ids.has(row.source_trader_id) ||
                      !isPublicRankingSourceAllowed(row.source)
                  )
                ) {
                  throw new Error(`Profile rank query crossed identity boundary for ${source}`)
                }
                return data
              })
            )
            return rows.flat()
          },
          { timeoutMs: 10_000 }
        )
      )
    )

    type ProfileSnapshot = {
      window: (typeof PROFILE_PERIODS)[number]
      metrics: NonNullable<AutoProfileInput['snapshot']>
      publishedCount: number
    }
    const bestSnapMap = new Map<string, ProfileSnapshot>()
    for (let periodIndex = 0; periodIndex < PROFILE_PERIODS.length; periodIndex++) {
      const period = PROFILE_PERIODS[periodIndex]
      const periodRead = periodReads[periodIndex]
      const publishedCounts = new Map(
        periodRead.publication.proofs.map((proof) => [proof.source, proof.published_rank_count])
      )
      for (const row of periodRead.value) {
        const key = rankIdentity(row.source, row.source_trader_id)
        if (bestSnapMap.has(key)) continue
        bestSnapMap.set(key, {
          window: period,
          publishedCount: publishedCounts.get(row.source) ?? 0,
          metrics: {
            roi: row.roi,
            pnl: row.pnl,
            win_rate: row.win_rate,
            max_drawdown: row.max_drawdown,
            trades_count: row.trades_count,
            followers: row.followers,
            copiers: row.copiers,
            aum: null,
            sharpe_ratio: row.sharpe_ratio,
            arena_score: row.arena_score,
            return_score: null,
            drawdown_score: null,
            stability_score: null,
            rank: row.rank,
          },
        })
      }
    }

    const snapshotResults = batch.map((profile) => {
      const best = bestSnapMap.get(rankIdentity(profile.platform, profile.trader_key))
      if (!best) return null
      return best
    })

    // Generate bios and tags, then batch upsert
    const updates: Array<{
      platform: string
      market_type: string
      trader_key: string
      bio: string
      tags: string[]
    }> = []

    for (let j = 0; j < batch.length; j++) {
      const profile = batch[j]
      const snapshotData = snapshotResults[j]

      try {
        const input: AutoProfileInput = {
          platform: profile.platform,
          trader_key: profile.trader_key,
          display_name: profile.display_name,
          snapshot: snapshotData?.metrics ?? null,
          snapshot_window: snapshotData?.window ?? null,
          total_traders_on_platform: snapshotData?.publishedCount ?? null,
        }

        const bio = generateAutoBio(input)
        const tags = generateAutoTags(input)

        updates.push({
          platform: profile.platform,
          market_type: profile.market_type,
          trader_key: profile.trader_key,
          bio: bio.en,
          tags,
        })
      } catch (err) {
        errors++
        if (errors <= 5) {
          logger.error(
            `[generate-profiles] Error for ${profile.platform}:${profile.trader_key}:`,
            err
          )
        }
      }
    }

    if (errors > 0) {
      throw new Error(`Profile generation failed for ${errors} profiles before persistence`)
    }

    // Conditional updates preserve the "never overwrite manual/exchange bios"
    // promise even if a human edits a profile after the candidate scan.
    if (updates.length > 0) {
      const updatedAt = new Date().toISOString()
      const writeResults = await Promise.all(
        updates.map(async (update) => {
          let updateQuery = supabase
            .from('trader_profiles_v2')
            .update({
              bio: update.bio,
              bio_source: 'auto',
              tags: update.tags,
              updated_at: updatedAt,
            })
            .eq('platform', update.platform)
            .eq('market_type', update.market_type)
            .eq('trader_key', update.trader_key)

          updateQuery = force
            ? updateQuery.or('bio_source.is.null,bio_source.eq.auto')
            : updateQuery.is('bio_source', null)

          const { data, error } = await updateQuery.select('trader_key')
          if (error || data === null) {
            throw new Error(
              `Profile conditional update failed for ${update.platform}:${update.trader_key}: ${error?.message ?? 'null payload'}`
            )
          }
          return data.length
        })
      )
      const updatedCount = writeResults.reduce((total, count) => total + count, 0)
      generated += updatedCount
      const concurrentlyProtected = updates.length - updatedCount
      skipped += concurrentlyProtected
      if (concurrentlyProtected > 0) {
        logger.warn(
          `[generate-profiles] Preserved ${concurrentlyProtected} profiles changed concurrently`
        )
      }
    }
  }

  logger.warn(
    `[generate-profiles] Done: ${generated} generated, ${skipped} skipped, ${errors} errors`
  )
  return { count: generated, skipped, errors, platforms: uniquePlatforms.length }
})

// Vercel cron sends GET — alias to POST handler
export const GET = handler
export async function POST(request: NextRequest) {
  return handler(request)
}
