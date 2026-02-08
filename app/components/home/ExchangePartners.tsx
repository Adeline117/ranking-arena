'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

const EXCHANGES = [
  'Binance', 'OKX', 'Bybit', 'Bitget', 'MEXC', 'KuCoin',
  'Gate.io', 'HTX', 'CoinEx', 'BingX', 'Phemex', 'WEEX',
]

export default function ExchangePartners() {
  const { t } = useLanguage()

  return (
    <div style={{
      textAlign: 'center',
      padding: '24px 0 8px',
      marginBottom: 8,
    }}>
      <div style={{
        fontSize: 12,
        fontWeight: 600,
        color: tokens.colors.text.tertiary,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 14,
      }}>
        {t('exchangePartnersTitle')}
      </div>
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: '8px 16px',
        maxWidth: 600,
        margin: '0 auto',
      }}>
        {EXCHANGES.map((name) => (
          <span
            key={name}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: tokens.colors.text.secondary,
              padding: '4px 8px',
              borderRadius: 6,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
            }}
          >
            {name}
          </span>
        ))}
      </div>
    </div>
  )
}
