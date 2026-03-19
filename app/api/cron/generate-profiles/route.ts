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
    await Promise.all(
      uniquePlatforms.map(async (platform) => {
        const { count } = await supabase
          .from('trader_profiles_v2')
          .select('*', { count: 'exact', head: true })
          .eq('platform', platform)

        platformCounts[platform] = count ?? 0
      })
    )

    // Step 3: Process each trader
    let generated = 0
    let skipped = 0
    let errors = 0

    // Process in batches of 50 for snapshot lookups
    const BATCH_SIZE = 50
    for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
      const batch = profiles.slice(i, i + BATCH_SIZE)

      // Fetch snapshots for this batch
      const snapshotResults = await Promise.all(
        batch.map(async (profile) => {
          // Try 90D first, then 30D, then 7D
          for (const window of ['90D', '30D', '7D'] as const) {
            const { data: snap } = await supabase
              .from('trader_snapshots_v2')
              .select('window, metrics')
              .eq('platform', profile.platform)
              .eq('trader_key', profile.trader_key)
              .eq('window', window)
              .order('as_of_ts', { ascending: false })
              .limit(1)
              .maybeSingle()

            if (snap?.metrics) {
              return { window, metrics: snap.metrics as Record<string, unknown> }
            }
          }

          return null
        })
      )

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
