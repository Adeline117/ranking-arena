'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

interface SubscriptionInfo {
  tier: string
  status: string
  currentPeriodEnd?: string
  trialEnd?: string
  cancelAtPeriodEnd?: boolean
}

interface SubscriptionStatusProps {
  subscription: SubscriptionInfo | null
}

/**
 * Displays subscription status with trial countdown
 * Shows:
 * - Current plan and status
 * - Trial end date with countdown badge when < 3 days remaining
 * - Cancellation pending notice
 */
export default function SubscriptionStatus({ subscription }: SubscriptionStatusProps) {
  const [daysRemaining, setDaysRemaining] = useState<number | null>(null)

  useEffect(() => {
    if (!subscription) return

    const endDate = subscription.trialEnd || subscription.currentPeriodEnd
    if (!endDate) return

    const end = new Date(endDate).getTime()
    const now = Date.now()
    const days = Math.ceil((end - now) / (1000 * 60 * 60 * 24))
    setDaysRemaining(days)
  }, [subscription])

  if (!subscription || subscription.tier === 'free') {
    return null
  }

  const isTrialing = subscription.status === 'trialing'
  const isPastDue = subscription.status === 'past_due'
  const showUrgentBadge = daysRemaining !== null && daysRemaining <= 3 && daysRemaining > 0
  const isExpired = daysRemaining !== null && daysRemaining <= 0

  const getStatusColor = () => {
    if (isPastDue || isExpired) return '#ef4444'
    if (showUrgentBadge) return '#f59e0b'
    if (isTrialing) return '#8b5cf6'
    return '#22c55e'
  }

  const getStatusText = () => {
    if (isExpired) return '已过期'
    if (isPastDue) return '付款逾期'
    if (isTrialing) return '试用中'
    if (subscription.cancelAtPeriodEnd) return '取消中'
    return '活跃'
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: tokens.spacing[2],
        }}
      >
        <Text size="sm" weight="bold">
          Pro 会员
        </Text>
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
          }}
        >
          <Box
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: getStatusColor(),
            }}
          />
          <Text size="xs" style={{ color: getStatusColor() }}>
            {getStatusText()}
          </Text>
        </Box>
      </Box>

      {/* Trial or period end date */}
      {daysRemaining !== null && (
        <Box style={{ marginTop: tokens.spacing[2] }}>
          {isTrialing && subscription.trialEnd && (
            <Text size="xs" color="tertiary">
              试用期至 {formatDate(subscription.trialEnd)}
            </Text>
          )}
          {!isTrialing && subscription.currentPeriodEnd && (
            <Text size="xs" color="tertiary">
              {subscription.cancelAtPeriodEnd ? '到期取消日' : '下次续费日'}：
              {formatDate(subscription.currentPeriodEnd)}
            </Text>
          )}
        </Box>
      )}

      {/* Urgent countdown badge */}
      {showUrgentBadge && (
        <Box
          style={{
            marginTop: tokens.spacing[3],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            background: 'rgba(245, 158, 11, 0.1)',
            borderRadius: tokens.radius.sm,
            border: '1px solid rgba(245, 158, 11, 0.3)',
          }}
        >
          <Text size="xs" style={{ color: '#f59e0b' }}>
            {isTrialing ? '试用' : '订阅'}将在 {daysRemaining} 天后{subscription.cancelAtPeriodEnd ? '取消' : '续费'}
          </Text>
        </Box>
      )}

      {/* Past due warning */}
      {isPastDue && (
        <Box
          style={{
            marginTop: tokens.spacing[3],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            background: 'rgba(239, 68, 68, 0.1)',
            borderRadius: tokens.radius.sm,
            border: '1px solid rgba(239, 68, 68, 0.3)',
          }}
        >
          <Text size="xs" style={{ color: '#ef4444' }}>
            付款失败，请更新支付方式以保持 Pro 权限
          </Text>
        </Box>
      )}
    </Box>
  )
}
