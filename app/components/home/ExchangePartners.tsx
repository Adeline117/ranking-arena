'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

const EXCHANGES = [
  'Binance', 'OKX', 'Bybit', 'Bitget', 'MEXC', 'KuCoin',
  'Gate.io', 'HTX', 'CoinEx', 'BingX', 'Phemex', 'WEEX',
  'Aevo', 'Hyperliquid', 'GMX', 'dYdX', 'Jupiter', 'Vertex',
  'Drift', 'Toobit', 'BTSE', 'Crypto.com', 'Bitfinex', 'WhiteBit',
  'LBank', 'Pionex', 'BloFin', 'XT.com', 'Kwenta', 'Synthetix',
  'MUX', 'Gains Network', 'Uniswap', 'PancakeSwap',
]

export default function ExchangePartners() {
  const { language } = useLanguage()

  // Double the list for seamless loop
  const doubled = [...EXCHANGES, ...EXCHANGES]

  return (
    <div style={{
      overflow: 'hidden',
      padding: '12px 0',
      borderBottom: `1px solid ${tokens.colors.border.primary}`,
      position: 'relative',
    }}>
      {/* Fade edges */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 40,
        background: `linear-gradient(to right, ${tokens.colors.bg.primary}, transparent)`,
        zIndex: 1, pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', right: 0, top: 0, bottom: 0, width: 40,
        background: `linear-gradient(to left, ${tokens.colors.bg.primary}, transparent)`,
        zIndex: 1, pointerEvents: 'none',
      }} />

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        animation: 'exchange-scroll 30s linear infinite',
        width: 'max-content',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: tokens.colors.text.tertiary,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          flexShrink: 0,
          paddingRight: 8,
        }}>
          {language === 'zh' ? '数据来源' : 'Sources'}
        </span>
        {doubled.map((name, i) => (
          <span
            key={`${name}-${i}`}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: tokens.colors.text.secondary,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              transition: `color ${tokens.transition.fast}`,
            }}
          >
            {name}
          </span>
        ))}
      </div>

      <style>{`
        @keyframes exchange-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  )
}
