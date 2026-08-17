'use client'

import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { isV1ReferralProgramPublished } from '@/lib/referral/v1-publication'

/**
 * The referral route deliberately renders status only while V1 publication is
 * fixed off. It must not fetch or generate referral links, copy links, or
 * present referral history as a pending/automatic reward.
 */
export default function ReferralClient() {
  const { t } = useLanguage()

  if (isV1ReferralProgramPublished()) return null

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <div
        style={{
          maxWidth: 700,
          margin: '0 auto',
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]} ${tokens.spacing[16]}`,
        }}
      >
        <div style={{ marginBottom: tokens.spacing[8], textAlign: 'center' }}>
          <h1
            style={{
              fontSize: 'clamp(28px, 3.5vw, 40px)',
              fontWeight: tokens.typography.fontWeight.black,
              margin: 0,
              letterSpacing: '-0.02em',
              lineHeight: 1.15,
            }}
          >
            {t('referralUnavailableTitle')}
          </h1>
          <p
            style={{
              fontSize: tokens.typography.fontSize.base,
              color: tokens.colors.text.secondary,
              marginTop: tokens.spacing[2],
              lineHeight: 1.5,
            }}
          >
            {t('referralUnavailableDescription')}
          </p>
        </div>

        <div
          role="status"
          aria-live="polite"
          style={{
            padding: tokens.spacing[6],
            background: tokens.glass.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: tokens.glass.border.light,
          }}
        >
          <p
            style={{
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {t('referralUnavailableHistoryNote')}
          </p>
        </div>
      </div>

      <FloatingActionButton />
    </div>
  )
}
