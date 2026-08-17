'use client'

import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

/**
 * V1 keeps the market-page bar's layout while global aggregate acquisition is
 * unavailable. It deliberately makes no request or availability claim.
 */
export default function GlobalMarketBar() {
  const { t } = useLanguage()

  return (
    <div
      style={{
        maxWidth: 1400,
        margin: '0 auto',
        padding: `${tokens.spacing[2]} ${tokens.spacing[5]} 0`,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: tokens.spacing[5],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.glass.bg.light,
          border: tokens.glass.border.light,
          borderRadius: tokens.radius.lg,
        }}
      >
        <div
          role="status"
          style={{
            minHeight: 36,
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          {t('dataUnavailable')}
        </div>
      </div>
    </div>
  )
}
