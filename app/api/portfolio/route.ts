/**
 * Portfolio CRUD API
 * GET /api/portfolio - List user portfolios
 * POST /api/portfolio - Retired in V1 (fixed 410; no credential write)
 * DELETE /api/portfolio?id=xxx - Remove a quarantined legacy connection
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
import { retiredPortfolioWrite, withPrivateNoStore } from './retired'

export const dynamic = 'force-dynamic'

interface LegacyPortfolioDeletionRpcClient {
  rpc(
    functionName: 'delete_legacy_portfolio_v1',
    args: {
      p_user_id: string
      p_portfolio_id: string
    }
  ): Promise<{
    data: unknown
    error: { code?: string; message?: string } | null
  }>
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return withPrivateNoStore(rateLimitResponse)

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('user_portfolios')
      .select('id, exchange, label, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    return withPrivateNoStore(success(data || []))
  } catch (err) {
    return withPrivateNoStore(handleError(err))
  }
}

export async function POST(_request: NextRequest) {
  return retiredPortfolioWrite('connect')
}

export async function DELETE(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return withPrivateNoStore(rateLimitResponse)

  try {
    const user = await requireAuth(request)
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return withPrivateNoStore(
        NextResponse.json({ error: 'Missing portfolio id' }, { status: 400 })
      )
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return withPrivateNoStore(
        NextResponse.json({ error: 'Invalid portfolio id' }, { status: 400 })
      )
    }

    const supabase = getSupabaseAdmin() as unknown as LegacyPortfolioDeletionRpcClient
    const { data: deleted, error } = await supabase.rpc('delete_legacy_portfolio_v1', {
      p_user_id: user.id,
      p_portfolio_id: id,
    })

    if (error) throw error
    if (deleted !== true && deleted !== false) {
      throw new Error('Legacy portfolio deletion returned an invalid result')
    }
    if (!deleted) {
      return withPrivateNoStore(
        NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
      )
    }

    return withPrivateNoStore(success({ deleted: true }))
  } catch (err) {
    return withPrivateNoStore(handleError(err))
  }
}
