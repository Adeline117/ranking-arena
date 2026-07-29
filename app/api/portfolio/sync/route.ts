/**
 * Portfolio Sync API
 * POST /api/portfolio/sync - Sync positions from exchange
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import logger from '@/lib/logger'
import { syncExchangePortfolio } from '@/lib/portfolio/exchange-sync'
import type { Json } from '@/lib/supabase/database.types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

type PortfolioSyncClaim = {
  status: 'claimed'
  portfolioId: string
  generation: number
}

type PortfolioSyncPublication =
  | {
      status: 'published'
      portfolioId: string
      generation: number
      positionCount: number
      syncedAt: string
    }
  | {
      status: 'superseded'
      generation: number
      currentGeneration: number
    }

function record(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function parseSyncClaim(value: unknown): PortfolioSyncClaim | 'not_found' | null {
  const result = record(value)
  if (!result) return null
  if (result.status === 'not_found') return 'not_found'
  if (
    result.status !== 'claimed' ||
    typeof result.portfolio_id !== 'string' ||
    !Number.isSafeInteger(result.generation) ||
    Number(result.generation) <= 0
  ) {
    return null
  }
  return {
    status: 'claimed',
    portfolioId: result.portfolio_id,
    generation: Number(result.generation),
  }
}

function parseSyncPublication(value: unknown): PortfolioSyncPublication | null {
  const result = record(value)
  if (!result) return null
  if (
    result.status === 'superseded' &&
    Number.isSafeInteger(result.generation) &&
    Number(result.generation) > 0 &&
    Number.isSafeInteger(result.current_generation) &&
    Number(result.current_generation) > Number(result.generation)
  ) {
    return {
      status: 'superseded',
      generation: Number(result.generation),
      currentGeneration: Number(result.current_generation),
    }
  }
  if (
    result.status !== 'published' ||
    typeof result.portfolio_id !== 'string' ||
    !Number.isSafeInteger(result.generation) ||
    Number(result.generation) <= 0 ||
    !Number.isSafeInteger(result.position_count) ||
    Number(result.position_count) < 0 ||
    typeof result.synced_at !== 'string'
  ) {
    return null
  }
  return {
    status: 'published',
    portfolioId: result.portfolio_id,
    generation: Number(result.generation),
    positionCount: Number(result.position_count),
    syncedAt: result.synced_at,
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const body = await request.json()
    const { portfolio_id } = body

    if (!portfolio_id) {
      return NextResponse.json({ error: 'Missing portfolio_id' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Verify ownership and get exchange info
    const { data: portfolio, error: pErr } = await supabase
      .from('user_portfolios')
      .select('id, exchange, api_key_encrypted, api_secret_encrypted, api_passphrase_encrypted')
      .eq('id', portfolio_id)
      .eq('user_id', user.id)
      .single()

    if (pErr || !portfolio) {
      return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
    }

    logger.info(
      `[portfolio/sync] Sync requested for portfolio ${portfolio_id}, exchange: ${portfolio.exchange}`
    )

    // Claim a monotonically increasing generation before any remote fetch.
    // If two requests overlap, only the newest claimed generation may publish,
    // regardless of which exchange request happens to finish last.
    const { data: rawClaim, error: claimError } = await supabase.rpc(
      'claim_portfolio_sync_generation_atomic',
      {
        p_actor_id: user.id,
        p_portfolio_id: portfolio.id,
      }
    )
    const claim = parseSyncClaim(rawClaim)
    if (claimError || !claim) {
      logger.error('[portfolio/sync] Failed to claim publication generation', {
        code: claimError?.code,
        portfolioId: portfolio.id,
      })
      return NextResponse.json({ error: 'Failed to start portfolio sync' }, { status: 500 })
    }
    if (claim === 'not_found') {
      return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
    }
    if (claim.portfolioId !== portfolio.id) {
      logger.error('[portfolio/sync] Generation claim returned the wrong portfolio', {
        portfolioId: portfolio.id,
        claimedPortfolioId: claim.portfolioId,
      })
      return NextResponse.json({ error: 'Failed to start portfolio sync' }, { status: 500 })
    }

    const result = await syncExchangePortfolio({
      portfolioId: portfolio.id,
      exchange: portfolio.exchange,
      apiKeyEncrypted: portfolio.api_key_encrypted,
      apiSecretEncrypted: portfolio.api_secret_encrypted,
      apiPassphraseEncrypted: portfolio.api_passphrase_encrypted,
      userId: user.id,
    })

    if (!result.ok) {
      // Non-fatal: surface a stable reason code + friendly message; the client
      // maps reason → localized copy. 400 only for a keys-unreadable state the
      // user can fix by reconnecting; everything else is a soft 200.
      const messages: Record<string, string> = {
        geo_unavailable: `Sync for ${portfolio.exchange} isn't available from our region yet — coming soon.`,
        passphrase_required: `${portfolio.exchange} requires an API passphrase. Passphrase support is coming soon; reconnect once available.`,
        unsupported: `Automatic sync for ${portfolio.exchange} isn't supported yet.`,
        keys_unreadable: `Could not read your stored API keys. Please remove and reconnect this exchange.`,
        exchange_error: `The exchange rejected the request. Check that your API key is valid and read-enabled.`,
      }
      const status = result.reason === 'keys_unreadable' ? 400 : 200
      return NextResponse.json(
        {
          data: {
            synced: false,
            reason: result.reason,
            message: messages[result.reason],
            portfolio_id,
            viewer_id: user.id,
          },
        },
        { status }
      )
    }

    const positions = result.positions.map((position) => ({
      symbol: position.symbol,
      side: position.side,
      entry_price: position.entry_price,
      mark_price: position.mark_price,
      size: position.size,
      pnl: position.pnl,
      pnl_pct: position.pnl_pct,
      leverage: position.leverage,
    }))
    const { data: rawPublication, error: publicationError } = await supabase.rpc(
      'publish_portfolio_sync_atomic',
      {
        p_actor_id: user.id,
        p_portfolio_id: portfolio.id,
        p_generation: claim.generation,
        p_synced_at: result.syncedAt,
        p_positions: positions as Json,
        p_total_equity: result.equity,
        p_total_pnl: result.pnl,
        p_total_pnl_pct: result.pnlPct,
      }
    )
    const publication = parseSyncPublication(rawPublication)
    if (publicationError || !publication) {
      logger.error('[portfolio/sync] Atomic publication failed', {
        code: publicationError?.code,
        generation: claim.generation,
        portfolioId: portfolio.id,
      })
      return NextResponse.json({ error: 'Failed to publish portfolio sync' }, { status: 500 })
    }
    if (publication.status === 'superseded') {
      return NextResponse.json(
        {
          data: {
            synced: false,
            reason: 'superseded',
            message: 'A newer portfolio sync is already in progress.',
            portfolio_id,
            viewer_id: user.id,
          },
        },
        { status: 409 }
      )
    }
    if (
      publication.portfolioId !== portfolio.id ||
      publication.generation !== claim.generation ||
      publication.positionCount !== result.positions.length ||
      publication.syncedAt !== result.syncedAt
    ) {
      logger.error('[portfolio/sync] Atomic publication ACK contradicted the snapshot', {
        generation: claim.generation,
        portfolioId: portfolio.id,
      })
      return NextResponse.json({ error: 'Failed to publish portfolio sync' }, { status: 500 })
    }

    return success({
      synced: true,
      positions: result.positions.length,
      total_equity: result.equity,
      portfolio_id,
      viewer_id: user.id,
    })
  } catch (err) {
    return handleError(err)
  }
}
