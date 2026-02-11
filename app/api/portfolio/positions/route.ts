/**
 * Portfolio Positions API
 * GET /api/portfolio/positions?portfolio_id=xxx - Get positions for a portfolio
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

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const { searchParams } = new URL(request.url)
    const portfolioId = searchParams.get('portfolio_id')

    const supabase = getSupabaseAdmin()

    if (portfolioId) {
      // Verify ownership
      const { data: portfolio } = await supabase
        .from('user_portfolios')
        .select('id')
        .eq('id', portfolioId)
        .eq('user_id', user.id)
        .single()

      if (!portfolio) {
        return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
      }

      const { data, error } = await supabase
        .from('user_positions')
        .select('*')
        .eq('portfolio_id', portfolioId)
        .order('pnl', { ascending: false })

      if (error) throw error
      return success(data || [])
    }

    // All positions across all user portfolios
    const { data: portfolios } = await supabase
      .from('user_portfolios')
      .select('id')
      .eq('user_id', user.id)

    if (!portfolios?.length) return success([])

    const portfolioIds = portfolios.map((p: { id: string }) => p.id)

    const { data, error } = await supabase
      .from('user_positions')
      .select('*, user_portfolios!inner(exchange, label)')
      .in('portfolio_id', portfolioIds)
      .order('pnl', { ascending: false })

    if (error) throw error
    return success(data || [])
  } catch (err) {
    return handleError(err)
  }
}
