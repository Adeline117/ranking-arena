'use client'

import { useState } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
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
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  const openPortal = async (flow?: 'subscription_update' | 'payment_method_update') => {
    try {
      const headers = await getAuthHeadersAsync()
      const res = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({
          returnUrl: `${window.location.origin}/user-center?tab=membership`,
          ...(flow ? { flow_data: { type: flow } } : {}),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        // Handle redirect response (e.g., no stripe_customer_id)
        if (data.redirect) {
          window.location.href = data.redirect
          return
        }
        if (data.url) {
          window.location.href = data.url
        } else {
          showToast(t('paymentSystemComingSoon'), 'error')
        }
      } else {
        showToast(t('paymentSystemComingSoon'), 'error')
      }
    } catch {
      showToast(t('operationFailedTryAgain'), 'error')
    }
  }

  return (
    <div style={{ ...cardStyle, marginBottom: 0 }}>
      <h3
        style={{
          fontSize: 16,
          fontWeight: 700,
          marginBottom: 16,
          color: tokens.colors.text.primary,
        }}
      >
        {t('manageSubscription')}
      </h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <button
          onClick={() => openPortal('subscription_update')}
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
          onClick={() => openPortal()}
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
        {info?.subscription && !info.subscription.cancelAtPeriodEnd && !showCancelConfirm && (
          <button
            onClick={() => setShowCancelConfirm(true)}
            style={{
              padding: '10px 20px',
              background: 'transparent',
              border: `1px solid ${alpha(tokens.colors.accent.error, 25)}`,
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
        {showCancelConfirm && (
          <div
            style={{
              width: '100%',
              padding: 16,
              background: `${alpha(tokens.colors.accent.error, 3)}`,
              border: `1px solid ${alpha(tokens.colors.accent.error, 19)}`,
              borderRadius: tokens.radius.lg,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                color: tokens.colors.text.primary,
              }}
            >
              {t('cancelSubscriptionConfirm')}
            </p>
            <p style={{ margin: 0, fontSize: 13, color: tokens.colors.text.secondary }}>
              {t('cancelSubscriptionNote')}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={async () => {
                  setShowCancelConfirm(false)
                  const headers = await getAuthHeadersAsync()
                  const res = await fetch('/api/stripe/portal', {
                    method: 'POST',
                    headers: {
                      ...headers,
                      'Content-Type': 'application/json',
                      ...getCsrfHeaders(),
                    },
                    body: JSON.stringify({
                      returnUrl: `${window.location.origin}/user-center?tab=membership`,
                    }),
                  })
                  if (res.ok) {
                    const data = await res.json()
                    if (data.redirect) {
                      window.location.href = data.redirect
                    } else if (data.url) {
                      window.location.href = data.url
                    }
                  }
                }}
                style={{
                  padding: '8px 16px',
                  background: tokens.colors.accent.error,
                  border: 'none',
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.white,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                {t('confirmCancel')}
              </button>
              <button
                onClick={() => setShowCancelConfirm(false)}
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.secondary,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                {t('keepSubscription')}
              </button>
            </div>
          </div>
        )}
        {info?.subscription?.cancelAtPeriodEnd && (
          <div
            style={{
              padding: '10px 20px',
              background: `${alpha(tokens.colors.accent.warning, 8)}`,
              border: `1px solid ${alpha(tokens.colors.accent.warning, 25)}`,
              borderRadius: tokens.radius.lg,
              color: tokens.colors.accent.warning,
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {t('subscriptionCancelAtEnd')}
          </div>
        )}
      </div>
    </div>
  )
}
