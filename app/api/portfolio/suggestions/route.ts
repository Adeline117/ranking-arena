/**
 * 跟单组合建议 API
 * GET /api/portfolio/suggestions - 获取组合建议
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  success,
  handleError,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { getLeaderboard } from '@/lib/data/unified'
import {
  generatePortfolioSuggestion,
  generateAllPortfolioSuggestions,
  type RiskPreference,
  type TraderForPortfolio,
} from '@/lib/utils/portfolio-builder'
import { getFeatureLimits } from '@/lib/types/premium'
import _logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portfolio/suggestions
 * 获取跟单组合建议
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    // 获取风险偏好参数
    const preferenceParam = searchParams.get('preference')
    const preference = validateEnum(
      preferenceParam,
      ['conservative', 'balanced', 'aggressive'] as const
    )

    // 获取当前用户（检查权限）
    const user = await getAuthUser(request)
    
    // 获取用户订阅信息
    let userTier: 'free' | 'pro' = 'free'
    if (user) {
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('tier')
        .eq('user_id', user.id)
        .maybeSingle()
      
      userTier = (subscription?.tier as typeof userTier) || 'free'
    }

    // 检查权限
    const limits = getFeatureLimits(userTier)
    if (limits.portfolioSuggestionsLimit === 0) {
      return NextResponse.json(
        {
          ok: false,
          message: 'Portfolio suggestions require Pro or higher',
          upgrade_required: true,
        },
        { status: 403 }
      )
    }

    // 获取交易员数据 via unified getLeaderboard
    const { traders: leaderboardTraders } = await getLeaderboard(supabase, {
      period: '90D',
      limit: 200,
      sortBy: 'roi',
      excludeOutliers: true,
    })

    // Filter to positive ROI traders only
    const filteredTraders = leaderboardTraders.filter(t => (t.roi ?? 0) >= 10)

    if (filteredTraders.length < 10) {
      return success({
        suggestions: [],
        message: 'Insufficient trader data to generate portfolio suggestions',
      })
    }

    // Map unified traders to TraderForPortfolio format
    const traders: TraderForPortfolio[] = filteredTraders.map(t => {
      return {
        trader_id: t.traderKey,
        source: t.platform,
        handle: t.handle || t.traderKey,
        roi: t.roi ?? 0,
        max_drawdown: t.maxDrawdown,
        win_rate: t.winRate,
        arena_score: t.arenaScore != null ? Math.round(t.arenaScore) : 0,
        followers: t.followers || 0,
        source_type: t.platform.includes('spot') ? 'spot' as const :
                     t.platform.includes('web3') ? 'web3' as const : 'futures' as const,
      }
    })

    // 生成建议
    let suggestions
    if (preference) {
      const suggestion = generatePortfolioSuggestion(traders, preference as RiskPreference)
      suggestions = suggestion ? [suggestion] : []
    } else {
      suggestions = generateAllPortfolioSuggestions(traders)
    }

    return success({
      suggestions,
      trader_pool_size: traders.length,
      generated_at: new Date().toISOString(),
    })
  } catch (error: unknown) {
    return handleError(error, 'portfolio suggestions')
  }
}
