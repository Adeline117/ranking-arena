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

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

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
      .select('id, exchange, api_key_encrypted, api_secret_encrypted')
      .eq('id', portfolio_id)
      .eq('user_id', user.id)
      .single()

    if (pErr || !portfolio) {
      return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
    }

    logger.info(
      `[portfolio/sync] Sync requested for portfolio ${portfolio_id}, exchange: ${portfolio.exchange}`
    )

    const result = await syncExchangePortfolio({
      portfolioId: portfolio.id,
      exchange: portfolio.exchange,
      apiKeyEncrypted: portfolio.api_key_encrypted,
      apiSecretEncrypted: portfolio.api_secret_encrypted,
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
          },
        },
        { status }
      )
    }

    // Full-snapshot sync WITHOUT a transient-wipe window: upsert the live
    // positions FIRST (never blanks existing data if this write fails), then
    // prune only rows this sync did not touch (updated_at older than syncedAt).
    // If the exchange authoritatively returned zero open positions, nothing is
    // upserted and the prune clears the (now-closed) rows — correct. A degraded
    // fetch throws earlier → reason:'exchange_error' → we never reach here, so a
    // failure can't wipe the portfolio.
    if (result.positions.length > 0) {
      const { error: upsertError } = await supabase
        .from('user_positions')
        .upsert(result.positions, { onConflict: 'portfolio_id,symbol,side' })
      if (upsertError) {
        logger.error('[portfolio/sync] Failed to upsert positions:', upsertError.message)
        return NextResponse.json({ error: 'Failed to sync positions' }, { status: 500 })
      }
    }

    const { error: pruneError } = await supabase
      .from('user_positions')
      .delete()
      .eq('portfolio_id', portfolio.id)
      .lt('updated_at', result.syncedAt)
    if (pruneError) {
      // Non-fatal: stale (closed) rows may linger until next sync, but live data is correct.
      logger.error('[portfolio/sync] Failed to prune stale positions:', pruneError.message)
    }

    // Best-effort snapshot — a failure here shouldn't fail the sync.
    const { error: snapError } = await supabase.from('user_portfolio_snapshots').insert({
      portfolio_id: portfolio.id,
      total_equity: result.equity,
      total_pnl: result.pnl,
      total_pnl_pct: result.pnlPct,
    })
    if (snapError) {
      logger.error('[portfolio/sync] Failed to write snapshot:', snapError.message)
    }

    return success({
      synced: true,
      positions: result.positions.length,
      total_equity: result.equity,
      portfolio_id,
    })
  } catch (err) {
    return handleError(err)
  }
}
