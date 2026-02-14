/**
 * 风险预警配置 API
 * 
 * GET    - 获取用户的预警配置
 * POST   - 创建/更新预警配置
 * DELETE - 删除预警配置
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { getRiskAlertService, DEFAULT_THRESHOLDS } from '@/lib/services/risk-alert'
import { hasFeatureAccess } from '@/lib/types/premium'
import type { SubscriptionTier } from '@/lib/types/premium'
import type { AlertType } from '@/lib/services/risk-alert'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

// 获取用户的预警配置
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const traderId = searchParams.get('traderId')

    // 检查用户是否是 Pro 会员
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier')
      .eq('id', user.id)
      .single()

    const tier = (profile?.subscription_tier || 'free') as SubscriptionTier
    
    if (!hasFeatureAccess(tier, 'trader_alerts')) {
      return NextResponse.json({
        success: false,
        error: 'Pro membership required',
        requiresPro: true,
        defaultThresholds: DEFAULT_THRESHOLDS,
      }, { status: 403 })
    }

    try {
      const service = getRiskAlertService()
      let configs = await service.getUserAlertConfigs(user.id)

      // 如果指定了 traderId，过滤结果
      if (traderId) {
        configs = configs.filter(c => c.traderId === traderId)
      }

      return NextResponse.json({
        success: true,
        data: {
          configs,
          defaultThresholds: DEFAULT_THRESHOLDS,
        },
      })
    } catch (error: unknown) {
      logger.error('[risk-alerts/config] 获取配置Failed:', error)
      return NextResponse.json({
        success: false,
        error: 'Failed to fetch config',
      }, { status: 500 })
    }
  },
  { name: 'get-alert-configs', rateLimit: 'authenticated' }
)

// 创建/更新预警配置
export const POST = withAuth(
  async ({ user, request, supabase }) => {
    const body = await request.json()
    const { traderId, traderHandle, alertType, threshold, enabled = true } = body

    // 验证参数
    if (!traderId || !alertType) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: traderId, alertType',
      }, { status: 400 })
    }

    const validAlertTypes: AlertType[] = ['drawdown', 'rank_drop', 'win_rate_drop', 'roi_change']
    if (!validAlertTypes.includes(alertType)) {
      return NextResponse.json({
        success: false,
        error: 'Invalid alert type',
      }, { status: 400 })
    }

    // 检查用户是否是 Pro 会员
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier')
      .eq('id', user.id)
      .single()

    const tier = (profile?.subscription_tier || 'free') as SubscriptionTier
    
    if (!hasFeatureAccess(tier, 'trader_alerts')) {
      return NextResponse.json({
        success: false,
        error: 'Pro membership required',
        requiresPro: true,
      }, { status: 403 })
    }

    // 使用默认阈值或用户指定的阈值
    const finalThreshold = threshold ?? DEFAULT_THRESHOLDS[alertType as keyof typeof DEFAULT_THRESHOLDS]?.warning ?? 0

    try {
      const service = getRiskAlertService()
      const config = await service.upsertAlertConfig({
        userId: user.id,
        traderId,
        traderHandle: traderHandle || traderId,
        alertType,
        threshold: finalThreshold,
        enabled,
      })

      return NextResponse.json({
        success: true,
        data: config,
      })
    } catch (error: unknown) {
      logger.error('[risk-alerts/config] 创建配置Failed:', error)
      return NextResponse.json({
        success: false,
        error: 'Failed to create config',
      }, { status: 500 })
    }
  },
  { name: 'upsert-alert-config', rateLimit: 'write' }
)

// 删除预警配置
export const DELETE = withAuth(
  async ({ user, request, supabase }) => {
    const { searchParams } = new URL(request.url)
    const traderId = searchParams.get('traderId')
    const alertType = searchParams.get('alertType') as AlertType

    if (!traderId || !alertType) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: traderId, alertType',
      }, { status: 400 })
    }

    // 检查用户是否是 Pro 会员
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier')
      .eq('id', user.id)
      .single()

    const tier = (profile?.subscription_tier || 'free') as SubscriptionTier
    
    if (!hasFeatureAccess(tier, 'trader_alerts')) {
      return NextResponse.json({
        success: false,
        error: 'Pro membership required',
        requiresPro: true,
      }, { status: 403 })
    }

    try {
      const service = getRiskAlertService()
      await service.deleteAlertConfig(user.id, traderId, alertType)

      return NextResponse.json({
        success: true,
      })
    } catch (error: unknown) {
      logger.error('[risk-alerts/config] 删除配置Failed:', error)
      return NextResponse.json({
        success: false,
        error: 'Failed to delete config',
      }, { status: 500 })
    }
  },
  { name: 'delete-alert-config', rateLimit: 'write' }
)
