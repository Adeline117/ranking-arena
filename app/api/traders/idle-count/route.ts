/**
 * GET /api/traders/idle-count?timeRange=90D[&exchange=…][&category=…]
 *
 * How many idle-window rows (no ROI and no PnL in the period) the ranking list
 * is hiding for this board. The homepage shows it at the end of the list:
 * "N more accounts with no trading this period · Show".
 *
 * An exact count from the public view, with the same cohort predicate and the
 * same exchange / category scope as /api/traders. When the read fails the
 * count is null — unknown is not zero, and the client then shows nothing.
 */
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { badRequest, success } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { parsePublicActiveRankingSource } from '@/lib/constants/exchanges'
import { applyPublicCohortFilters } from '@/lib/rankings/public-cohort'
import { isPublicRankingSourceQuarantined } from '@/lib/rankings/publication-policy'

const logger = createLogger('traders-idle-count')

const querySchema = z.object({
  timeRange: z.enum(['7D', '30D', '90D']).optional().default('90D'),
  exchange: z.string().max(64).optional(),
  category: z.enum(['futures', 'spot', 'onchain']).optional(),
})

export const GET = withPublic(
  async ({ supabase, request }) => {
    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
    if (!parsed.success) return badRequest('Invalid parameters')
    const { timeRange, exchange, category } = parsed.data

    if (exchange !== undefined) {
      // A quarantined source publishes nothing, so it hides nothing either.
      if (isPublicRankingSourceQuarantined(exchange)) return success({ count: 0 })
      if (parsePublicActiveRankingSource(exchange) === null) return badRequest('Invalid exchange')
    }

    let query = applyPublicCohortFilters(
      supabase
        .from('public_ranked_leaderboard')
        .select('source_trader_id', { count: 'exact', head: true })
        .eq('season_id', timeRange)
    ).eq('idle_window', true)
    if (exchange) {
      query = query.eq('source', exchange)
    } else if (category) {
      // Same mapping as /api/traders: `onchain` is stored as `web3`.
      query = query.eq('source_type', category === 'onchain' ? 'web3' : category)
    }

    const { count, error } = await query
    if (error) {
      logger.warn('idle-window count failed', { timeRange, message: error.message })
      return success({ count: null })
    }
    return success({
      count: typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null,
    })
  },
  { name: 'traders-idle-count', rateLimit: 'read' }
)
