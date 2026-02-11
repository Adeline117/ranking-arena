'use client'

import { useLanguage } from '../Providers/LanguageProvider'
import ExchangeLogo from '../ui/ExchangeLogo'
import { SOURCES_WITH_DATA, EXCHANGE_CONFIG } from '@/lib/constants/exchanges'

/**
 * Map DB source keys to ExchangeLogo keys and display names.
 * We deduplicate by exchange (e.g. binance_futures + binance_spot → Binance).
 */
function getUniqueExchanges() {
  const SOURCE_TO_LOGO: Record<string, string> = {
    binance_futures: 'binance',
    binance_spot: 'binance',
    binance_web3: 'binance',
    bybit: 'bybit',
    bybit_spot: 'bybit',
    bitget_futures: 'bitget',
    bitget_spot: 'bitget',
    okx_futures: 'okx',
    okx_spot: 'okx',
    okx_web3: 'okx',
    okx_wallet: 'okx',
    mexc: 'mexc',
    kucoin: 'kucoin',
    coinex: 'coinex',
    htx_futures: 'htx',
    weex: 'weex',
    phemex: 'phemex',
    bingx: 'bingx',
    gateio: 'gate',
    xt: 'xt',
    lbank: 'lbank',
    blofin: 'blofin',
    bitmart: 'bitmart',
    gmx: 'gmx',
    dydx: 'dydx',
    hyperliquid: 'hyperliquid',
    gains: 'gains',
    jupiter_perps: 'jupiter',
    aevo: 'aevo',
    dune_gmx: 'gmx',
    dune_hyperliquid: 'hyperliquid',
    dune_uniswap: 'uniswap',
    dune_defi: 'defi',
    web3_bot: 'web3',
  }

  // Short display names (deduplicated by logo key)
  const DISPLAY_NAMES: Record<string, string> = {
    binance: 'Binance',
    bybit: 'Bybit',
    bitget: 'Bitget',
    okx: 'OKX',
    mexc: 'MEXC',
    kucoin: 'KuCoin',
    coinex: 'CoinEx',
    htx: 'HTX',
    weex: 'WEEX',
    phemex: 'Phemex',
    bingx: 'BingX',
    gate: 'Gate.io',
    xt: 'XT.COM',
    lbank: 'LBank',
    blofin: 'BloFin',
    bitmart: 'BitMart',
    gmx: 'GMX',
    dydx: 'dYdX',
    hyperliquid: 'Hyperliquid',
    gains: 'Gains',
    jupiter: 'Jupiter',
    aevo: 'Aevo',
  }

  const seen = new Set<string>()
  const result: { logoKey: string; name: string }[] = []

  for (const source of SOURCES_WITH_DATA) {
    const logoKey = SOURCE_TO_LOGO[source]
    if (!logoKey || seen.has(logoKey)) continue
    // Skip internal/meta sources that don't have meaningful logos
    if (logoKey === 'defi' || logoKey === 'web3') continue
    seen.add(logoKey)
    result.push({
      logoKey,
      name: DISPLAY_NAMES[logoKey] || EXCHANGE_CONFIG[source]?.name || logoKey,
    })
  }

  return result
}

const EXCHANGES = getUniqueExchanges()

export default function ExchangePartners() {
  const { language } = useLanguage()

  return (
    <div style={{
      padding: '16px 0 12px',
      borderBottom: '1px solid var(--color-border-primary)',
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--color-text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        marginBottom: 10,
        paddingLeft: 4,
      }}>
        {language === 'zh' ? `数据来源 · ${EXCHANGES.length} 个平台` : `Data Sources · ${EXCHANGES.length} Platforms`}
      </div>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px 16px',
        alignItems: 'center',
      }}>
        {EXCHANGES.map((ex) => (
          <span
            key={ex.logoKey}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            <ExchangeLogo exchange={ex.logoKey} size={16} />
            {ex.name}
          </span>
        ))}
      </div>
    </div>
  )
}
