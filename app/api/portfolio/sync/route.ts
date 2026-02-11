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

export const dynamic = 'force-dynamic'

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

    // TODO: Implement actual exchange API calls using connectors
    // For now, return a placeholder response indicating sync is not yet implemented
    // Future: use connectors/[exchange] to fetch real positions
    logger.info(`[portfolio/sync] Sync requested for portfolio ${portfolio_id}, exchange: ${portfolio.exchange}`)

    // Placeholder: In production, this would:
    // 1. Decrypt API keys
    // 2. Call exchange API via connectors
    // 3. Upsert positions into user_positions
    // 4. Create a snapshot in user_portfolio_snapshots

    return success({
      synced: false,
      message: `Exchange sync for ${portfolio.exchange} is not yet implemented. Connect your exchange API keys and check back soon.`,
      portfolio_id,
    })
  } catch (err) {
    return handleError(err)
  }
}
