'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const cardStyle = {
  padding: '10px 12px',
  background: tokens.glass.bg.secondary,
  backdropFilter: tokens.glass.blur.md,
  borderRadius: tokens.radius.md,
  border: tokens.glass.border.light,
}

export default function ExchangeVolume() {
  const { t } = useLanguage()

  return (
    <div style={cardStyle}>
      <div
        style={{
          fontSize: 10,
          color: tokens.colors.text.tertiary,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 6,
        }}
      >
        {t('exchangeVolume')}
      </div>
      <div
        role="status"
        style={{
          fontSize: 11,
          color: tokens.colors.text.tertiary,
          textAlign: 'center',
          padding: '4px 0',
        }}
      >
        {t('dataUnavailable')}
      </div>
    </div>
  )
}
