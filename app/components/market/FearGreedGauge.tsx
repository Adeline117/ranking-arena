'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/**
 * V1 local presentation for the retired fear-and-greed acquisition ingress.
 * It intentionally never derives a market sentiment value or starts a request.
 */
export default function FearGreedGauge() {
  const { t } = useLanguage()

  return (
    <div
      style={{
        padding: tokens.spacing[5],
        background: tokens.glass.bg.medium,
        backdropFilter: tokens.glass.blur.lg,
        borderRadius: tokens.radius.xl,
        border: tokens.glass.border.light,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: tokens.gradient.purple,
          opacity: 0.6,
        }}
      />

      <div
        style={{
          fontSize: tokens.typography.fontSize.base,
          fontWeight: 700,
          color: tokens.colors.text.primary,
          marginBottom: tokens.spacing[2],
          letterSpacing: '0.3px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>{t('fearGreedTitle')}</span>
        <span
          style={{
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
            fontWeight: tokens.typography.fontWeight.medium,
            padding: `${tokens.spacing[0.5]} ${tokens.spacing[2]}`,
            borderRadius: tokens.radius.sm,
            background: tokens.colors.bg.tertiary,
          }}
        >
          {t('dataUnavailable')}
        </span>
      </div>

      <div
        role="status"
        style={{
          display: 'flex',
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.sm,
          textAlign: 'center',
        }}
      >
        {t('dataUnavailable')}
      </div>
    </div>
  )
}
