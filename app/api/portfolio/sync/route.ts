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
  userId: string
  portfolioId: string
  exchange: string
  generation: number
  credentialGeneration: number
  apiKeyEncrypted: string
  apiSecretEncrypted: string
  apiPassphraseEncrypted: string | null
}

type PortfolioLifecycleStatus = 'not_found' | 'inactive' | 'missing_account' | 'suspended'

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
      credentialGeneration?: number
      currentCredentialGeneration?: number
    }

function record(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function parseSyncClaim(value: unknown): PortfolioSyncClaim | PortfolioLifecycleStatus | null {
  const result = record(value)
  if (!result) return null
  if (
    result.status === 'not_found' ||
    result.status === 'inactive' ||
    result.status === 'missing_account' ||
    result.status === 'suspended'
  ) {
    return result.status
  }
  if (
    result.status !== 'claimed' ||
    typeof result.user_id !== 'string' ||
    typeof result.portfolio_id !== 'string' ||
    typeof result.exchange !== 'string' ||
    !Number.isSafeInteger(result.generation) ||
    Number(result.generation) <= 0 ||
    !Number.isSafeInteger(result.credential_generation) ||
    Number(result.credential_generation) <= 0 ||
    typeof result.api_key_encrypted !== 'string' ||
    !result.api_key_encrypted ||
    typeof result.api_secret_encrypted !== 'string' ||
    !result.api_secret_encrypted ||
    !(
      result.api_passphrase_encrypted === null ||
      typeof result.api_passphrase_encrypted === 'string'
    )
  ) {
    return null
  }
  return {
    status: 'claimed',
    userId: result.user_id,
    portfolioId: result.portfolio_id,
    exchange: result.exchange,
    generation: Number(result.generation),
    credentialGeneration: Number(result.credential_generation),
    apiKeyEncrypted: result.api_key_encrypted,
    apiSecretEncrypted: result.api_secret_encrypted,
    apiPassphraseEncrypted: result.api_passphrase_encrypted,
  }
}

function parseSyncPublication(
  value: unknown
): PortfolioSyncPublication | PortfolioLifecycleStatus | null {
  const result = record(value)
  if (!result) return null
  if (
    result.status === 'not_found' ||
    result.status === 'inactive' ||
    result.status === 'missing_account' ||
    result.status === 'suspended'
  ) {
    return result.status
  }
  if (
    result.status === 'superseded' &&
    Number.isSafeInteger(result.generation) &&
    Number(result.generation) > 0 &&
    Number.isSafeInteger(result.current_generation) &&
    Number(result.current_generation) > 0 &&
    (Number(result.current_generation) > Number(result.generation) ||
      (Number.isSafeInteger(result.credential_generation) &&
        Number(result.credential_generation) > 0 &&
        Number.isSafeInteger(result.current_credential_generation) &&
        Number(result.current_credential_generation) > Number(result.credential_generation)))
  ) {
    return {
      status: 'superseded',
      generation: Number(result.generation),
      currentGeneration: Number(result.current_generation),
      ...(Number.isSafeInteger(result.credential_generation)
        ? { credentialGeneration: Number(result.credential_generation) }
        : {}),
      ...(Number.isSafeInteger(result.current_credential_generation)
        ? { currentCredentialGeneration: Number(result.current_credential_generation) }
        : {}),
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

    // Claim ownership, active-account state, one sync generation, and the exact
    // credential generation in a single transaction before any remote fetch.
    const { data: rawClaim, error: claimError } = await supabase.rpc(
      'claim_portfolio_sync_generation_atomic',
      {
        p_actor_id: user.id,
        p_portfolio_id: portfolio_id,
      }
    )
    const claim = parseSyncClaim(rawClaim)
    if (claimError || !claim) {
      logger.error('[portfolio/sync] Failed to claim publication generation', {
        code: claimError?.code,
        portfolioId: portfolio_id,
      })
      return NextResponse.json({ error: 'Failed to start portfolio sync' }, { status: 500 })
    }
    if (claim === 'not_found') {
      return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
    }
    if (claim === 'inactive') {
      return NextResponse.json(
        {
          data: {
            synced: false,
            reason: 'keys_unreadable',
            message: 'Please remove and reconnect this exchange before syncing.',
            portfolio_id,
            viewer_id: user.id,
          },
        },
        { status: 409 }
      )
    }
    if (claim === 'missing_account' || claim === 'suspended') {
      return NextResponse.json({ error: 'Account is inactive' }, { status: 403 })
    }
    if (claim.portfolioId !== portfolio_id || claim.userId !== user.id) {
      logger.error('[portfolio/sync] Generation claim returned the wrong portfolio', {
        portfolioId: portfolio_id,
        claimedPortfolioId: claim.portfolioId,
      })
      return NextResponse.json({ error: 'Failed to start portfolio sync' }, { status: 500 })
    }

    logger.info(
      `[portfolio/sync] Sync requested for portfolio ${portfolio_id}, exchange: ${claim.exchange}`
    )

    const result = await syncExchangePortfolio({
      portfolioId: claim.portfolioId,
      exchange: claim.exchange,
      apiKeyEncrypted: claim.apiKeyEncrypted,
      apiSecretEncrypted: claim.apiSecretEncrypted,
      apiPassphraseEncrypted: claim.apiPassphraseEncrypted,
      userId: user.id,
    })

    if (!result.ok) {
      // Non-fatal: surface a stable reason code + friendly message; the client
      // maps reason → localized copy. 400 only for a keys-unreadable state the
      // user can fix by reconnecting; everything else is a soft 200.
      const messages: Record<string, string> = {
        geo_unavailable: `Sync for ${claim.exchange} isn't available from our region yet — coming soon.`,
        passphrase_required: `${claim.exchange} requires an API passphrase. Passphrase support is coming soon; reconnect once available.`,
        unsupported: `Automatic sync for ${claim.exchange} isn't supported yet.`,
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
      'publish_active_portfolio_sync_atomic',
      {
        p_actor_id: user.id,
        p_portfolio_id: claim.portfolioId,
        p_generation: claim.generation,
        p_credential_generation: claim.credentialGeneration,
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
        portfolioId: claim.portfolioId,
      })
      return NextResponse.json({ error: 'Failed to publish portfolio sync' }, { status: 500 })
    }
    if (publication === 'not_found') {
      return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
    }
    if (publication === 'inactive') {
      return NextResponse.json(
        {
          data: {
            synced: false,
            reason: 'keys_unreadable',
            message: 'Please remove and reconnect this exchange before syncing.',
            portfolio_id,
            viewer_id: user.id,
          },
        },
        { status: 409 }
      )
    }
    if (publication === 'missing_account' || publication === 'suspended') {
      return NextResponse.json({ error: 'Account is inactive' }, { status: 403 })
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
      publication.portfolioId !== claim.portfolioId ||
      publication.generation !== claim.generation ||
      publication.positionCount !== result.positions.length ||
      publication.syncedAt !== result.syncedAt
    ) {
      logger.error('[portfolio/sync] Atomic publication ACK contradicted the snapshot', {
        generation: claim.generation,
        portfolioId: claim.portfolioId,
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
