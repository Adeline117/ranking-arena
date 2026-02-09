'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import ExchangeLogo from '../ui/ExchangeLogo'
import type { Exchange } from '@/lib/exchange'

const EXCHANGES: { name: string; key: Exchange }[] = [
  { name: 'Binance', key: 'binance' },
  { name: 'OKX', key: 'okx' },
  { name: 'Bybit', key: 'bybit' },
  { name: 'Bitget', key: 'bitget' },
  { name: 'MEXC', key: 'mexc' },
  { name: 'KuCoin', key: 'kucoin' },
  { name: 'Gate.io', key: 'gate' },
  { name: 'HTX', key: 'htx' },
  { name: 'CoinEx', key: 'coinex' },
  { name: 'BingX', key: 'bingx' as Exchange },
  { name: 'Phemex', key: 'phemex' as Exchange },
  { name: 'WEEX', key: 'weex' },
  { name: 'Aevo', key: 'aevo' as Exchange },
  { name: 'Hyperliquid', key: 'hyperliquid' as Exchange },
  { name: 'GMX', key: 'gmx' as Exchange },
  { name: 'dYdX', key: 'dydx' as Exchange },
  { name: 'Jupiter', key: 'jupiter' as Exchange },
  { name: 'Vertex', key: 'vertex' as Exchange },
  { name: 'Drift', key: 'drift' as Exchange },
  { name: 'Toobit', key: 'toobit' as Exchange },
  { name: 'BTSE', key: 'btse' as Exchange },
  { name: 'Crypto.com', key: 'cryptocom' as Exchange },
  { name: 'Bitfinex', key: 'bitfinex' as Exchange },
  { name: 'WhiteBit', key: 'whitebit' as Exchange },
  { name: 'LBank', key: 'lbank' as Exchange },
  { name: 'Pionex', key: 'pionex' as Exchange },
  { name: 'BloFin', key: 'blofin' as Exchange },
  { name: 'XT.com', key: 'xt' as Exchange },
  { name: 'Uniswap', key: 'uniswap' as Exchange },
  { name: 'PancakeSwap', key: 'pancakeswap' as Exchange },
]

export default function ExchangePartners() {
  const { language } = useLanguage()

  const doubled = [...EXCHANGES, ...EXCHANGES]

  return (
    <div style={{
      overflow: 'hidden',
      padding: '10px 0',
      borderBottom: `1px solid var(--color-border-primary)`,
      position: 'relative',
    }}>
      {/* Fade edges */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 40,
        background: `linear-gradient(to right, var(--color-bg-primary), transparent)`,
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
        gap: 20,
        animation: 'exchange-scroll 35s linear infinite',
        width: 'max-content',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: tokens.colors.text.tertiary,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          flexShrink: 0,
          paddingLeft: 8,
          paddingRight: 4,
        }}>
          {language === 'zh' ? '数据来源' : 'Sources'}
        </span>
        {doubled.map((ex, i) => (
          <span
            key={`${ex.key}-${i}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              fontWeight: 600,
              color: tokens.colors.text.secondary,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <ExchangeLogo exchange={ex.key} size={18} />
            {ex.name}
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
