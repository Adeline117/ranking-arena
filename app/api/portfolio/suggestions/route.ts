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
import {
  generatePortfolioSuggestion,
  generateAllPortfolioSuggestions,
  type RiskPreference,
  type TraderForPortfolio,
} from '@/lib/utils/portfolio-builder'
import { getFeatureLimits } from '@/lib/types/premium'

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
          message: '组合建议功能需要升级到 Pro 或更高版本',
          upgrade_required: true,
        },
        { status: 403 }
      )
    }

    // 获取交易员数据
    const { data: tradersData, error: tradersError } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, source, roi, max_drawdown, win_rate, followers')
      .eq('season_id', '90D')
      .gte('roi', 10)  // 只选择正收益的交易员
      .order('roi', { ascending: false })
      .limit(200)

    if (tradersError) {
      console.error('[Portfolio] 获取交易员数据失败:', tradersError)
      return handleError(tradersError, 'portfolio suggestions')
    }

    if (!tradersData || tradersData.length < 10) {
      return success({
        suggestions: [],
        message: '交易员数据不足，无法生成组合建议',
      })
    }

    // 获取 handle 信息
    const traderIds = tradersData.map(t => t.source_trader_id)
    const { data: sources } = await supabase
      .from('trader_sources')
      .select('source_trader_id, handle, source')
      .in('source_trader_id', traderIds)

    const handleMap = new Map<string, string>()
    sources?.forEach(s => {
      handleMap.set(`${s.source_trader_id}:${s.source}`, s.handle || s.source_trader_id)
    })

    // 计算 Arena Score（简化版）
    const traders: TraderForPortfolio[] = tradersData.map(t => {
      const key = `${t.source_trader_id}:${t.source}`
      // 简化的 Arena Score 计算
      const roi = t.roi || 0
      const drawdown = Math.abs(t.max_drawdown || 0)
      const winRate = t.win_rate || 50
      
      const roiScore = Math.min(roi / 2, 85)  // 最高 85
      const drawdownScore = Math.max(0, 8 - drawdown / 5)
      const stabilityScore = Math.max(0, (winRate - 45) / 3.5)
      
      return {
        trader_id: t.source_trader_id,
        source: t.source,
        handle: handleMap.get(key) || t.source_trader_id,
        roi,
        max_drawdown: t.max_drawdown,
        win_rate: t.win_rate,
        arena_score: Math.round(roiScore + drawdownScore + stabilityScore),
        followers: t.followers || 0,
        source_type: t.source.includes('spot') ? 'spot' as const : 
                     t.source.includes('web3') ? 'web3' as const : 'futures' as const,
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
  } catch (error) {
    return handleError(error, 'portfolio suggestions')
  }
}
