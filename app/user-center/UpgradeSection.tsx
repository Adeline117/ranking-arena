'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { CrownIcon } from './MembershipIcons'
import { PRICING, type PlanType } from './membership-config'

interface UpgradeSectionProps {
  selectedPlan: PlanType
  setSelectedPlan: (plan: PlanType) => void
  subscribing: boolean
  onSubscribe: () => void
  cardStyle: React.CSSProperties
  t: (key: string) => string
}

export default function UpgradeSection({
  selectedPlan,
  setSelectedPlan,
  subscribing,
  onSubscribe,
  cardStyle,
  t,
}: UpgradeSectionProps) {
  const yearlySavings = Math.round((1 - (PRICING.yearly.price / 12) / PRICING.monthly.price) * 100)

  return (
    <div style={{
      ...cardStyle,
      border: '1px solid var(--color-pro-glow)',
      background: `linear-gradient(135deg, ${tokens.colors.bg.tertiary} 0%, ${tokens.colors.bg.secondary} 100%)`,
    }}>
      {/* Header */}
      <Box style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: tokens.spacing[5],
      }}>
        <Box style={{ color: 'var(--color-pro-gradient-start)' }}>
          <CrownIcon size={20} />
        </Box>
        <Text size="lg" weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
          {t('pricingTitle')}
        </Text>
      </Box>

      <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[5], lineHeight: 1.6 }}>
        {t('pricingDescription')}
      </Text>

      {/* Plan Selector */}
      <Box style={{ marginBottom: tokens.spacing[5] }}>
        {/* Monthly */}
        <PlanOption
          selected={selectedPlan === 'monthly'}
          onClick={() => setSelectedPlan('monthly')}
          t={t}
          titleKey="monthlyPlan"
          subtitleKey="monthlySubscription"
          price={`$${PRICING.monthly.price}`}
          priceSubKey="perMonth"
        />

        {/* Yearly */}
        <Box
          onClick={() => setSelectedPlan('yearly')}
          style={{
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.lg,
            border: `2px solid ${selectedPlan === 'yearly' ? 'var(--color-pro-gradient-start)' : 'var(--color-border-primary)'}`,
            background: selectedPlan === 'yearly' ? 'var(--color-pro-glow)' : 'transparent',
            cursor: 'pointer',
            transition: 'all 0.2s',
            position: 'relative',
          }}
        >
          <Box
            style={{
              position: 'absolute',
              top: -8,
              right: 12,
              padding: '2px 8px',
              background: 'var(--color-accent-success)',
              borderRadius: tokens.radius.full,
              fontSize: 10,
              fontWeight: 700,
              color: tokens.colors.white,
            }}
          >
            {t('savePercent').replace('{percent}', String(yearlySavings))}
          </Box>

          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Box>
              <Text size="sm" weight="bold">{t('yearlyPlan')}</Text>
              <Text size="xs" color="tertiary">{t('bestValue')}</Text>
            </Box>
            <Box style={{ textAlign: 'right' }}>
              <Box style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <Text size="xs" style={{ textDecoration: 'line-through', color: 'var(--color-text-tertiary)' }}>
                  ${PRICING.yearly.original}
                </Text>
                <Text size="xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                  ${PRICING.yearly.price}
                </Text>
              </Box>
              <Text size="xs" color="tertiary">
                {t('approxPerMonth').replace('{price}', (PRICING.yearly.price / 12).toFixed(1))}
              </Text>
            </Box>
          </Box>
        </Box>

        {/* Lifetime */}
        <Box
          onClick={() => setSelectedPlan('lifetime')}
          style={{
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.lg,
            border: `2px solid ${selectedPlan === 'lifetime' ? '#f59e0b' : 'var(--color-border-primary)'}`,
            background: selectedPlan === 'lifetime' ? 'color-mix(in srgb, #f59e0b 8%, transparent)' : 'transparent',
            cursor: 'pointer',
            transition: 'all 0.2s',
            position: 'relative',
            marginTop: tokens.spacing[3],
          }}
        >
          <Box
            style={{
              position: 'absolute',
              top: -8,
              right: 12,
              padding: '2px 8px',
              background: 'var(--color-founding-accent, #f59e0b)',
              borderRadius: tokens.radius.full,
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--color-on-accent, #fff)',
            }}
          >
            {t('membershipLifetimeSpots').replace('{spots}', String(PRICING.lifetime.spots))}
          </Box>

          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Box>
              <Text size="sm" weight="bold" style={{ color: 'var(--color-founding-accent, #f59e0b)' }}>{t('membershipFoundingLifetime')}</Text>
              <Text size="xs" color="tertiary">{t('membershipOneTimeForever')}</Text>
            </Box>
            <Box style={{ textAlign: 'right' }}>
              <Text size="xl" weight="black" style={{ color: 'var(--color-founding-accent, #f59e0b)' }}>
                ${PRICING.lifetime.price}
              </Text>
              <Text size="xs" color="tertiary">{t('membershipOneTime')}</Text>
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Subscribe Button */}
      <Button
        variant="primary"
        onClick={onSubscribe}
        disabled={subscribing}
        style={{
          width: '100%',
          padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
          background: selectedPlan === 'lifetime' ? '#f59e0b' : 'var(--color-pro-badge-bg)',
          border: 'none',
          boxShadow: selectedPlan === 'lifetime' ? '0 4px 16px rgba(245,158,11,0.3)' : '0 4px 16px var(--color-pro-badge-shadow)',
          fontSize: tokens.typography.fontSize.md,
          fontWeight: 700,
        }}
      >
        {subscribing
          ? t('processing')
          : selectedPlan === 'lifetime'
            ? t('membershipGetFoundingAccess').replace('{price}', String(PRICING.lifetime.price))
            : `${t('startSubscription')} - $${selectedPlan === 'yearly' ? PRICING.yearly.price : PRICING.monthly.price}`}
      </Button>

      <Box style={{ marginTop: tokens.spacing[3], textAlign: 'center' }}>
        <Text size="xs" color="tertiary" style={{ lineHeight: 1.6 }}>
          {selectedPlan === 'lifetime'
            ? t('membershipLifetimeNote')
            : `${t('cancelAnytime')} · ${t('securePayment')}`}
        </Text>
      </Box>
    </div>
  )
}

// Simple plan option (used for Monthly)
function PlanOption({
  selected,
  onClick,
  t,
  titleKey,
  subtitleKey,
  price,
  priceSubKey,
}: {
  selected: boolean
  onClick: () => void
  t: (key: string) => string
  titleKey: string
  subtitleKey: string
  price: string
  priceSubKey: string
}) {
  return (
    <Box
      onClick={onClick}
      style={{
        padding: tokens.spacing[4],
        borderRadius: tokens.radius.lg,
        border: `2px solid ${selected ? 'var(--color-pro-gradient-start)' : 'var(--color-border-primary)'}`,
        background: selected ? 'var(--color-pro-glow)' : 'transparent',
        cursor: 'pointer',
        transition: 'all 0.2s',
        marginBottom: tokens.spacing[3],
      }}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          <Text size="sm" weight="bold">{t(titleKey)}</Text>
          <Text size="xs" color="tertiary">{t(subtitleKey)}</Text>
        </Box>
        <Box style={{ textAlign: 'right' }}>
          <Text size="xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
            {price}
          </Text>
          <Text size="xs" color="tertiary">{t(priceSubKey)}</Text>
        </Box>
      </Box>
    </Box>
  )
}
