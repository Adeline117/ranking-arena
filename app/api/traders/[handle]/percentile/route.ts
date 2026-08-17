/**
 * 交易员分位排名 API
 * Pro 会员功能：获取交易员在同类中的百分位排名
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  error,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { hasFeatureAccess, normalizeSubscriptionTier } from '@/lib/types/premium'
import { SOURCE_TYPE_MAP, type SourceType } from '@/lib/constants/exchanges'

export const runtime = 'nodejs'

interface PercentileData {
  overall: null // 总分百分位：尚无可验证的同类 cohort
  return: null // 收益分百分位：尚无可验证的同类 cohort
  drawdown: null // 回撤分百分位：尚无可验证的同类 cohort
  stability: null // 稳定分百分位：尚无可验证的同类 cohort
  totalInCategory: null // 同类交易员总数：尚无同谓词的原子计数证明
}

/**
 * GET - 获取交易员在同类中的百分位排名
 *
 * A percentile needs a single, sealed category cohort and a count taken from
 * that exact cohort. The public ranking view intentionally proves individual
 * rank rows, but does not yet expose an atomic category-percentile proof.
 * Return unknown until that authority exists instead of fabricating 50% from
 * raw rows or estimated counts.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rl = await checkRateLimit(request, RateLimitPresets.read)
  if (rl) return rl

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 获取用户订阅等级
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()

    const tier = normalizeSubscriptionTier(subscription?.tier)

    // 检查是否有权限
    if (!hasFeatureAccess(tier, 'score_breakdown')) {
      return error('Pro membership required', 403)
    }

    // 解析参数
    const resolvedParams = await params
    const handle = decodeURIComponent(resolvedParams.handle)

    // Resolve trader via unified layer
    const resolved = await resolveTrader(supabase, { handle })
    if (!resolved) {
      return error('Trader not found', 404)
    }

    const percentile: PercentileData = {
      overall: null,
      return: null,
      drawdown: null,
      stability: null,
      totalInCategory: null,
    }

    return success({
      percentile,
      category: (SOURCE_TYPE_MAP[resolved.platform] ?? null) as SourceType | null,
      coverage_state: 'unknown',
      rank_eligible: false,
      reason: 'published_percentile_cohort_unavailable',
    })
  } catch (err: unknown) {
    return handleError(err)
  }
}
