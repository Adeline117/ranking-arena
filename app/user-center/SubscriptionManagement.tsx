'use client'

import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import type { MembershipInfo } from './membership-config'

interface SubscriptionManagementProps {
  info: MembershipInfo | null
  cardStyle: React.CSSProperties
  getAuthHeadersAsync: () => Promise<Record<string, string>>
  t: (key: string) => string
}

export default function SubscriptionManagement({
  info,
  cardStyle,
  getAuthHeadersAsync,
  t,
}: SubscriptionManagementProps) {
  const { showToast } = useToast()

  const openPortal = async () => {
    try {
      const headers = await getAuthHeadersAsync()
      const res = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl: `${window.location.origin}/user-center?tab=membership` }),
      })
      if (res.ok) {
        const { url } = await res.json()
        window.location.href = url
      } else {
        showToast(t('paymentSystemComingSoon'), 'error')
      }
    } catch {
      showToast(t('operationFailedTryAgain'), 'error')
    }
  }

  return (
    <div style={{ ...cardStyle, marginBottom: 0 }}>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
        {t('manageSubscription')}
      </h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <button
          onClick={openPortal}
          style={{
            padding: '10px 20px',
            background: tokens.colors.accent.brand,
            border: 'none',
            borderRadius: tokens.radius.lg,
            color: tokens.colors.white,
            fontWeight: 600,
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          {t('changePlan')}
        </button>
        <button
          onClick={openPortal}
          style={{
            padding: '10px 20px',
            background: 'transparent',
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.lg,
            color: tokens.colors.text.secondary,
            fontWeight: 600,
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          {t('billingHistory')}
        </button>
        {info?.subscription && !info.subscription.cancelAtPeriodEnd && (
          <button
            onClick={async () => {
              if (!confirm(t('cancelSubscriptionConfirm'))) return
              const headers = await getAuthHeadersAsync()
              const res = await fetch('/api/stripe/portal', {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ returnUrl: `${window.location.origin}/user-center?tab=membership` }),
              })
              if (res.ok) {
                const { url } = await res.json()
                window.location.href = url
              }
            }}
            style={{
              padding: '10px 20px',
              background: 'transparent',
              border: `1px solid ${tokens.colors.accent.error}40`,
              borderRadius: tokens.radius.lg,
              color: tokens.colors.accent.error,
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {t('cancelSubscription')}
          </button>
        )}
        {info?.subscription?.cancelAtPeriodEnd && (
          <div style={{
            padding: '10px 20px',
            background: `${tokens.colors.accent.warning}15`,
            border: `1px solid ${tokens.colors.accent.warning}40`,
            borderRadius: tokens.radius.lg,
            color: tokens.colors.accent.warning,
            fontWeight: 600,
            fontSize: 14,
          }}>
            {t('subscriptionCancelAtEnd')}
          </div>
        )}
      </div>
    </div>
  )
}
