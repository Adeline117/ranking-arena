/**
 * 风险预警 API
 * 
 * GET  - 获取用户的预警列表
 * POST - 标记预警为已读
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { getRiskAlertService } from '@/lib/services/risk-alert'
import { hasFeatureAccess } from '@/lib/types/premium'
import type { SubscriptionTier } from '@/lib/types/premium'

export const dynamic = 'force-dynamic'

// 获取用户的预警列表
export const GET = withAuth(
  async ({ user, supabase }) => {
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
        error: '此功能需要 Pro 会员',
        requiresPro: true,
      }, { status: 403 })
    }

    try {
      const service = getRiskAlertService()
      const alerts = await service.getUnreadAlerts(user.id, 50)

      return NextResponse.json({
        success: true,
        data: {
          alerts,
          unreadCount: alerts.length,
        },
      })
    } catch (error) {
      console.error('[risk-alerts] 获取预警失败:', error)
      return NextResponse.json({
        success: false,
        error: '获取预警失败',
      }, { status: 500 })
    }
  },
  { name: 'get-risk-alerts', rateLimit: 'authenticated' }
)

// 标记预警为已读
export const POST = withAuth(
  async ({ user, request, supabase }) => {
    const body = await request.json()
    const { alertId, markAll } = body

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
        error: '此功能需要 Pro 会员',
        requiresPro: true,
      }, { status: 403 })
    }

    try {
      const service = getRiskAlertService()

      if (markAll) {
        await service.markAllAlertsAsRead(user.id)
      } else if (alertId) {
        await service.markAlertAsRead(alertId, user.id)
      } else {
        return NextResponse.json({
          success: false,
          error: '需要提供 alertId 或 markAll',
        }, { status: 400 })
      }

      return NextResponse.json({
        success: true,
      })
    } catch (error) {
      console.error('[risk-alerts] 标记预警失败:', error)
      return NextResponse.json({
        success: false,
        error: '标记预警失败',
      }, { status: 500 })
    }
  },
  { name: 'mark-risk-alert', rateLimit: 'write' }
)
