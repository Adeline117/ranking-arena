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

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { generateAutoBio, generateAutoTags, type AutoProfileInput } from '@/lib/utils/auto-profile'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { logger } from '@/lib/logger'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Vercel cron sends GET — alias to POST handler
export async function GET(request: NextRequest) {
  return POST(request)
}

export async function POST(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('generate-profiles')

  try {
    const url = new URL(request.url)
    const limit = parseInt(url.searchParams.get('limit') || '500', 10)
    const force = url.searchParams.get('force') === 'true'

    const supabase = getSupabaseAdmin()

    // Step 1: Find traders that need auto-generated profiles
    // Only process traders with: bio IS NULL, or bio_source = 'auto' (refresh)
    // Never touch bio_source = 'manual' or bio_source = 'exchange'
    let query = supabase
      .from('trader_profiles_v2')
      .select('platform, market_type, trader_key, display_name, bio, bio_source')
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (force) {
      // Regenerate all auto bios + empty bios (skip manual/exchange)
      query = query.or('bio.is.null,bio_source.is.null,bio_source.eq.auto')
    } else {
      // Only fill empty bios
      query = query.or('bio.is.null,bio_source.is.null')
    }

    const { data: profiles, error: fetchErr } = await query

    if (fetchErr) {
      await plog.error(new Error(`Failed to fetch profiles: ${fetchErr.message}`))
      return NextResponse.json({ error: fetchErr.message }, { status: 500 })
    }

    if (!profiles || profiles.length === 0) {
      await plog.success(0, { message: 'No profiles need generation' })
      return NextResponse.json({ ok: true, generated: 0 })
    }

    logger.warn(`[generate-profiles] Processing ${profiles.length} traders`)

    // Step 2: For each trader, fetch their best snapshot for bio context
    // We batch by platform to get total trader counts for percentile calculation
    const platformCounts: Record<string, number> = {}
    const uniquePlatforms = [...new Set(profiles.map(p => p.platform))]

    // Get total trader count per platform (for percentile tags)
    // Estimated is fine — percentile bands are coarse (Top 1%, Top 5%, etc.)
    // and pg_class.reltuples is within ~5% accuracy. Avoids per-platform
    // exact count on trader_profiles_v2 which can be slow under cron load.
    await Promise.all(
      uniquePlatforms.map(async (platform) => {
        const { count } = await supabase
          .from('trader_profiles_v2')
          .select('*', { count: 'estimated', head: true })
          .eq('platform', platform)

        platformCounts[platform] = count ?? 0
      })
    )

    // Step 3: Process each trader
    let generated = 0
    const skipped = 0
    let errors = 0

    // Process in batches of 50 for snapshot lookups
    const BATCH_SIZE = 50
    for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
      const batch = profiles.slice(i, i + BATCH_SIZE)

      // Batch-fetch from leaderboard_ranks (authoritative, same source as UI display)
      // Previously read from trader_snapshots_v2.metrics JSONB which was stale,
      // causing bios to show different numbers than the trader page.
      const batchKeys = batch.map(p => p.trader_key)
      const { data: batchLR } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, source, season_id, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, sharpe_ratio, arena_score, rank')
        .in('source_trader_id', batchKeys)
        .in('season_id', ['90D', '30D', '7D'])

      // Build a map: trader_key → best period data (prefer 90D > 30D > 7D)
      const WINDOW_PRIORITY: Record<string, number> = { '90D': 3, '30D': 2, '7D': 1 }
      const bestSnapMap = new Map<string, { window: string; metrics: Record<string, unknown> }>()
      for (const row of batchLR ?? []) {
        const key = row.source_trader_id
        const existing = bestSnapMap.get(key)
        const snapPriority = WINDOW_PRIORITY[row.season_id] ?? 0
        const existingPriority = existing ? (WINDOW_PRIORITY[existing.window] ?? 0) : -1
        if (snapPriority > existingPriority) {
          bestSnapMap.set(key, {
            window: row.season_id,
            metrics: {
              roi: row.roi,
              pnl: row.pnl,
              win_rate: row.win_rate,
              max_drawdown: row.max_drawdown,
              trades_count: row.trades_count,
              followers: row.followers,
              copiers: row.copiers,
              sharpe_ratio: row.sharpe_ratio,
              arena_score: row.arena_score,
              rank: row.rank,
            },
          })
        }
      }

      const snapshotResults = batch.map(profile => {
        const best = bestSnapMap.get(profile.trader_key)
        if (!best) return null
        return { window: best.window as '7D' | '30D' | '90D', metrics: best.metrics }
      })

      // Generate bios and tags, then batch upsert
      const updates: Array<{
        platform: string
        market_type: string
        trader_key: string
        bio: string
        bio_source: string
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
            snapshot: snapshotData ? (snapshotData.metrics as unknown as AutoProfileInput['snapshot']) : null,
            snapshot_window: snapshotData ? (snapshotData.window as '7D' | '30D' | '90D') : null,
            total_traders_on_platform: platformCounts[profile.platform] || null,
          }

          const bio = generateAutoBio(input)
          const tags = generateAutoTags(input)

          updates.push({
            platform: profile.platform,
            market_type: profile.market_type,
            trader_key: profile.trader_key,
            bio: bio.en,
            bio_source: 'auto',
            tags,
          })

          generated++
        } catch (err) {
          errors++
          if (errors <= 5) {
            logger.error(`[generate-profiles] Error for ${profile.platform}:${profile.trader_key}:`, err)
          }
        }
      }

      // Batch upsert
      if (updates.length > 0) {
        const { error: upsertErr } = await supabase
          .from('trader_profiles_v2')
          .upsert(
            updates.map(u => ({
              platform: u.platform,
              market_type: u.market_type,
              trader_key: u.trader_key,
              bio: u.bio,
              bio_source: u.bio_source,
              tags: u.tags,
              updated_at: new Date().toISOString(),
            })),
            { onConflict: 'platform,market_type,trader_key' }
          )

        if (upsertErr) {
          logger.error(`[generate-profiles] Upsert error: ${upsertErr.message}`)
          errors += updates.length
          generated -= updates.length
        }
      }
    }

    logger.warn(`[generate-profiles] Done: ${generated} generated, ${skipped} skipped, ${errors} errors`)

    await plog.success(generated, { skipped, errors })

    return NextResponse.json({
      ok: true,
      generated,
      skipped,
      errors,
      platforms: uniquePlatforms.length,
    })
  } catch (error) {
    logger.error('[generate-profiles] Unexpected error:', error)
    await plog.error(error instanceof Error ? error : new Error(String(error)))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
