/**
 * GET /api/traders/aggregate?user_id=xxx or ?handle=xxx
 *
 * Returns aggregated stats across all linked trader accounts for a user.
 * Public endpoint — used by trader profile pages to show multi-account data.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin, success, handleError, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getAggregatedStats, findUserByTrader } from '@/lib/data/linked-traders'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { searchParams } = new URL(request.url)
    let userId = searchParams.get('user_id')
    const handle = searchParams.get('handle')
    const platform = searchParams.get('platform')
    const traderKey = searchParams.get('trader_key')

    const supabase = getSupabaseAdmin()

    // Resolve user_id from handle if not provided directly
    if (!userId && handle) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('handle', handle)
        .maybeSingle()

      if (profile?.id) {
        userId = String(profile.id)
      }
    }

    // Resolve user_id from trader platform+key
    if (!userId && platform && traderKey) {
      userId = await findUserByTrader(supabase, platform, traderKey)
    }

    if (!userId) {
      return success({
        aggregated: null,
        accounts: [],
        totalAccounts: 0,
      })
    }

    const stats = await getAggregatedStats(supabase, userId)

    if (!stats) {
      return success({
        aggregated: null,
        accounts: [],
        totalAccounts: 0,
      })
    }

    return success({
      aggregated: {
        combinedPnl: stats.combinedPnl,
        bestRoi: stats.bestRoi,
        weightedScore: stats.weightedScore,
      },
      accounts: stats.accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        traderKey: a.traderKey,
        handle: a.handle,
        label: a.label,
        isPrimary: a.isPrimary,
        roi: a.roi,
        pnl: a.pnl,
        arenaScore: a.arenaScore,
        winRate: a.winRate,
        maxDrawdown: a.maxDrawdown,
        rank: a.rank,
      })),
      totalAccounts: stats.totalAccounts,
    })
  } catch (error: unknown) {
    return handleError(error, 'traders/aggregate GET')
  }
}
