/**
 * POST /api/pipeline/ingest
 *
 * Accepts pre-scraped trader data from VPS and writes to DB.
 * Decouples scraping (VPS, no timeout) from writing (Vercel → Supabase).
 *
 * Auth: VPS_PROXY_KEY header (same key as VPS scraper)
 * Body: { platform, window, traders: [...] }
 *
 * Flow: VPS scraper → HTTP POST here → validateBeforeWrite → upsertTraders → DB
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { validateBeforeWrite, logRejectedWrites } from '@/lib/pipeline/validate-before-write'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { logger } from '@/lib/logger'
import { env } from '@/lib/env'
import { safeCompare } from '@/lib/auth/verify-service-auth'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { truncateToHour } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface IngestTrader {
  trader_key: string
  display_name?: string | null
  roi_pct?: number | null
  pnl_usd?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  trades_count?: number | null
  followers?: number | null
  copiers?: number | null
  sharpe_ratio?: number | null
  arena_score?: number | null
  avatar_url?: string | null
}

interface IngestBody {
  platform: string
  window: string // '7D', '30D', '90D'
  traders: IngestTrader[]
}

export async function POST(request: NextRequest) {
  // RETIRED 2026-06-15 (ARENA_DATA_SPEC endgame): the legacy VPS scraper ingest
  // is redundant — the Mac Mini arena worker now covers all serving sources
  // (writes arena.* + compat trader_latest under the same legacy-alias rows), so
  // this path only kept trader_snapshots_v2 (a table being dropped) growing.
  // Disabled by default; set LEGACY_VPS_INGEST_ENABLED=true to re-enable.
  if (process.env.LEGACY_VPS_INGEST_ENABLED !== 'true') {
    return NextResponse.json(
      {
        ok: false,
        disabled: true,
        reason: 'legacy VPS ingest retired; arena pipeline is canonical',
      },
      { status: 410 }
    )
  }

  // Auth: accept either VPS proxy key or CRON_SECRET (timing-safe)
  const proxyKey =
    request.headers.get('x-proxy-key') ||
    request.headers.get('authorization')?.replace('Bearer ', '')
  const validKeys = [process.env.VPS_PROXY_KEY, env.CRON_SECRET].filter(Boolean) as string[]
  const isAuthed = proxyKey && validKeys.some((k) => safeCompare(proxyKey, k))
  if (!validKeys.length || !isAuthed) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const plog = await PipelineLogger.start('pipeline-ingest')

  try {
    const body = (await request.json()) as IngestBody
    const { platform, window: win, traders } = body

    if (!platform || !win || !Array.isArray(traders) || traders.length === 0) {
      return NextResponse.json({ error: 'Missing platform, window, or traders' }, { status: 400 })
    }

    const marketType = SOURCE_TYPE_MAP[platform] || 'futures'
    const asOfTs = truncateToHour()

    // Build snapshot rows
    const rows = traders.map((t) => ({
      platform,
      market_type: marketType,
      trader_key: t.trader_key,
      window: win.toUpperCase(),
      as_of_ts: asOfTs,
      roi_pct: t.roi_pct ?? null,
      pnl_usd: t.pnl_usd ?? null,
      win_rate: t.win_rate ?? null,
      max_drawdown: t.max_drawdown ?? null,
      trades_count: t.trades_count ?? null,
      followers: t.followers ?? null,
      copiers: t.copiers ?? null,
      sharpe_ratio: t.sharpe_ratio ?? null,
      arena_score: t.arena_score ?? null,
      updated_at: new Date().toISOString(),
    }))

    // Validate through gatekeeper
    const { valid, rejected } = validateBeforeWrite(
      rows as unknown as Record<string, unknown>[],
      'trader_snapshots_v2'
    )

    const supabase = getSupabaseAdmin() as SupabaseClient
    if (rejected.length) logRejectedWrites(rejected, supabase)

    // Batch upsert
    let upserted = 0
    const BATCH = 500
    for (let i = 0; i < valid.length; i += BATCH) {
      const batch = valid.slice(i, i + BATCH)
      const { error } = await supabase
        .from('trader_snapshots_v2')
        .upsert(batch, { onConflict: 'platform,market_type,trader_key,window,as_of_ts' })
      if (error) {
        logger.error(`[ingest] Upsert batch ${i} failed: ${error.message}`)
      } else {
        upserted += batch.length
      }
    }

    // Also upsert trader identities
    const traderRows = traders
      .filter((t) => t.trader_key)
      .map((t) => ({
        source: platform,
        source_trader_id: t.trader_key,
        market_type: marketType,
        handle: t.display_name || null,
        avatar_url: t.avatar_url || null,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      }))

    if (traderRows.length > 0) {
      // Dedupe by source_trader_id
      const seen = new Set<string>()
      const unique = traderRows.filter((r) => {
        if (seen.has(r.source_trader_id)) return false
        seen.add(r.source_trader_id)
        return true
      })
      await supabase
        .from('trader_sources')
        .upsert(unique, { onConflict: 'source,source_trader_id' })
        .then(({ error }) => {
          if (error) logger.warn(`[ingest] Traders upsert: ${error.message}`)
        })
    }

    const elapsed = Date.now() - startTime
    await plog.success(upserted, {
      platform,
      window: win,
      received: traders.length,
      rejected: rejected.length,
      upserted,
    })

    return NextResponse.json({
      ok: true,
      platform,
      window: win,
      received: traders.length,
      rejected: rejected.length,
      upserted,
      elapsed_ms: elapsed,
    })
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    await plog.error(err)
    logger.error('[ingest] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
