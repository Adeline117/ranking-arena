import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import ExchangeLogo from '../ui/ExchangeLogo'
import type { Exchange } from '@/lib/exchange'

// Map display exchange key to the primary DB source used in /rankings/[exchange]
const EXCHANGE_SOURCE_MAP: Record<string, string> = {
  binance: 'binance_futures',
  okx: 'okx_futures',
  bybit: 'bybit',
  bitget: 'bitget_futures',
  mexc: 'mexc',
  gate: 'gateio',
  htx: 'htx_futures',
  coinex: 'coinex',
  bingx: 'bingx',
  phemex: 'phemex',
  aevo: 'aevo',
  hyperliquid: 'hyperliquid',
  gmx: 'gmx',
  dydx: 'dydx',
  jupiter: 'jupiter_perps',
  toobit: 'toobit',
  btcc: 'btcc',
  bitfinex: 'bitfinex',
  etoro: 'etoro',
  blofin: 'blofin',
  xt: 'xt',
  gains: 'gains',
}

const EXCHANGES: { name: string; key: Exchange }[] = [
  { name: 'Binance', key: 'binance' },
  { name: 'OKX', key: 'okx' },
  { name: 'Bybit', key: 'bybit' },
  { name: 'Bitget', key: 'bitget' },
  { name: 'MEXC', key: 'mexc' },
  { name: 'Gate.io', key: 'gate' },
  { name: 'HTX', key: 'htx' },
  { name: 'CoinEx', key: 'coinex' },
  { name: 'BingX', key: 'bingx' as Exchange },
  { name: 'Phemex', key: 'phemex' as Exchange },
  { name: 'Aevo', key: 'aevo' as Exchange },
  { name: 'Hyperliquid', key: 'hyperliquid' as Exchange },
  { name: 'GMX', key: 'gmx' as Exchange },
  { name: 'dYdX', key: 'dydx' as Exchange },
  { name: 'Jupiter', key: 'jupiter' as Exchange },
  { name: 'Toobit', key: 'toobit' as Exchange },
  { name: 'BTCC', key: 'btcc' as Exchange },
  { name: 'Bitfinex', key: 'bitfinex' as Exchange },
  { name: 'BloFin', key: 'blofin' as Exchange },
  { name: 'XT.com', key: 'xt' as Exchange },
  { name: 'Gains', key: 'gains' as Exchange },
  { name: 'eToro', key: 'etoro' as Exchange },
]

const DOUBLED_EXCHANGES = [...EXCHANGES, ...EXCHANGES]

export default function ExchangePartners() {

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
        background: `linear-gradient(to left, var(--color-bg-primary), transparent)`,
        zIndex: 1, pointerEvents: 'none',
      }} />

      <div className="exchange-scroll-track" style={{
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        animation: 'exchange-scroll 35s linear infinite',
        width: 'max-content',
      }}>
        {DOUBLED_EXCHANGES.map((ex, i) => {
          const source = EXCHANGE_SOURCE_MAP[ex.key] || ''
          const content = (
            <>
              <ExchangeLogo exchange={ex.key} size={18} />
              {ex.name}
            </>
          )
          const sharedStyle: React.CSSProperties = {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text-secondary)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            textDecoration: 'none',
            padding: '4px 10px',
            borderRadius: tokens.radius.md,
            transition: `all ${tokens.transition.base}`,
          }
          return source ? (
            <Link
              key={`${ex.key}-${i}`}
              href={`/rankings/${source}`}
              prefetch={false}
              className="exchange-item"
              style={sharedStyle}
            >
              {content}
            </Link>
          ) : (
            <span
              key={`${ex.key}-${i}`}
              className="exchange-item"
              style={sharedStyle}
            >
              {content}
            </span>
          )
        })}
      </div>

      <style>{`
        @keyframes exchange-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0s !important; }
        }
        .exchange-scroll-track:hover {
          animation-play-state: paused !important;
        }
        .exchange-item:hover {
          background: var(--color-bg-hover) !important;
          color: var(--color-text-primary) !important;
        }
      `}</style>
    </div>
  )
}
