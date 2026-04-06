'use client'

import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import type { MembershipInfo } from './membership-config'

interface CurrentPlanCardProps {
  isPro: boolean
  info: MembershipInfo | null
  language: string
  cardStyle: React.CSSProperties
  t: (key: string) => string
}

export default function CurrentPlanCard({ isPro, info, language, cardStyle, t }: CurrentPlanCardProps) {
  const tierLabel = isPro ? 'Pro' : 'Free'
  const tierColor = isPro ? tokens.colors.accent.brand : tokens.colors.text.tertiary

  return (
    <div style={cardStyle}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16,
        marginBottom: info?.subscription ? 16 : 0,
      }}>
        <div>
          <div style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginBottom: 4 }}>
            {t('currentPlan')}
          </div>
          <div style={{
            fontSize: 28,
            fontWeight: 900,
            color: tierColor,
          }}>
            {tierLabel}
          </div>
        </div>
      </div>

      {/* Expiry Warning */}
      {info?.subscription?.currentPeriodEnd && (() => {
        const daysUntilExpiry = Math.ceil((new Date(info.subscription!.currentPeriodEnd!).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        if (daysUntilExpiry <= 7 && daysUntilExpiry > 0 && info.subscription!.cancelAtPeriodEnd) {
          return (
            <div style={{
              padding: '12px 16px',
              background: `${tokens.colors.accent.warning}15`,
              border: `1px solid ${tokens.colors.accent.warning}40`,
              borderRadius: tokens.radius.lg,
              marginBottom: 16,
              fontSize: 14,
              color: tokens.colors.accent.warning,
              fontWeight: 600,
            }}>
              {t('proExpiryWarning').replace('{days}', String(daysUntilExpiry))}
            </div>
          )
        }
        return null
      })()}

      {/* Subscription Details */}
      {info?.subscription && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 16,
          paddingTop: 16,
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <div>
            <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
              {t('subscriptionStatusLabel')}
            </div>
            <div style={{ fontWeight: 600, marginTop: 4, color: tokens.colors.text.primary }}>
              {info.subscription.status === 'active' ? t('statusActive') :
                info.subscription.status === 'canceled' ? t('statusCanceled') :
                  info.subscription.status === 'past_due' ? t('statusPastDue') : info.subscription.status}
            </div>
          </div>
          {info.subscription.plan && (
            <div>
              <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                {t('billingCycle')}
              </div>
              <div style={{ fontWeight: 600, marginTop: 4, color: tokens.colors.text.primary }}>
                {info.subscription.plan === 'yearly' ? t('yearlyPrice') : t('monthlyPrice')}
              </div>
            </div>
          )}
          {info.subscription.currentPeriodEnd && (
            <div>
              <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                {info.subscription.cancelAtPeriodEnd ? t('expiresLabel') : t('nextRenewal')}
              </div>
              <div style={{ fontWeight: 600, marginTop: 4, color: tokens.colors.text.primary }}>
                {new Date(info.subscription.currentPeriodEnd).toLocaleDateString(
                  getLocaleFromLanguage(language)
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
