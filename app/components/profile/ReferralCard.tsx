'use client'

import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { isV1ReferralProgramPublished } from '@/lib/referral/v1-publication'

/**
 * Settings keeps a status card rather than an invitation control while the V1
 * referral-program publication gate is closed. Do not restore link generation,
 * copying, progress, or reward claims here without a separately published flow.
 */
export default function ReferralCard() {
  const { t } = useLanguage()

  if (isV1ReferralProgramPublished()) return null

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: tokens.glass.bg.medium,
        border: tokens.glass.border.light,
        borderRadius: tokens.radius.xl,
        padding: tokens.spacing[5],
        backdropFilter: tokens.glass.blur.sm,
        WebkitBackdropFilter: tokens.glass.blur.sm,
      }}
    >
      <h3
        style={{
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.semibold,
          color: tokens.colors.text.primary,
          margin: `0 0 ${tokens.spacing[2]}`,
        }}
      >
        {t('referralUnavailableTitle')}
      </h3>
      <p
        style={{
          fontSize: tokens.typography.fontSize.sm,
          color: tokens.colors.text.secondary,
          margin: `0 0 ${tokens.spacing[2]}`,
          lineHeight: 1.5,
        }}
      >
        {t('referralUnavailableDescription')}
      </p>
      <p
        style={{
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.tertiary,
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        {t('referralUnavailableHistoryNote')}
      </p>
    </div>
  )
}
