'use client'

import { useState } from 'react'
import { Box } from '@/app/components/base'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'

interface ExchangeLogoProps {
  exchange: string
  size?: number
  className?: string
}

// Local logo files in /public/icons/exchanges/
// All logos sourced from official exchange favicons via scripts/sync-exchange-logos.sh
// NEVER use CoinGecko CDN — it returns wrong images (caused 17 wrong logos)
const LOCAL_LOGOS: Record<string, string> = {
  binance: '/icons/exchanges/binance.png',
  bybit: '/icons/exchanges/bybit.png',
  bitget: '/icons/exchanges/bitget.png',
  mexc: '/icons/exchanges/mexc.png',
  htx: '/icons/exchanges/htx.png',
  weex: '/icons/exchanges/weex.png',
  coinex: '/icons/exchanges/coinex.png',
  okx: '/icons/exchanges/okx.png',
  kucoin: '/icons/exchanges/kucoin.png',
  gate: '/icons/exchanges/gate.png',
  bingx: '/icons/exchanges/bingx.png',
  phemex: '/icons/exchanges/phemex.png',
  hyperliquid: '/icons/exchanges/hyperliquid.png',
  gmx: '/icons/exchanges/gmx.png',
  dydx: '/icons/exchanges/dydx.png',
  jupiter: '/icons/exchanges/jupiter.png',
  drift: '/icons/exchanges/drift.png',
  aevo: '/icons/exchanges/aevo.png',
  vertex: '/icons/exchanges/vertex.png',
  toobit: '/icons/exchanges/toobit.png',
  btse: '/icons/exchanges/btse.png',
  cryptocom: '/icons/exchanges/cryptocom.png',
  bitfinex: '/icons/exchanges/bitfinex.png',
  whitebit: '/icons/exchanges/whitebit.png',
  lbank: '/icons/exchanges/lbank.png',
  pionex: '/icons/exchanges/pionex.png',
  blofin: '/icons/exchanges/blofin.png',
  xt: '/icons/exchanges/xt.png',
  uniswap: '/icons/exchanges/uniswap.png',
  pancakeswap: '/icons/exchanges/pancakeswap.png',
  kwenta: '/icons/exchanges/kwenta.png',
  synthetix: '/icons/exchanges/synthetix.png',
  mux: '/icons/exchanges/mux.png',
  gains: '/icons/exchanges/gains.png',
  btcc: '/icons/exchanges/btcc.png',
  bitunix: '/icons/exchanges/bitunix.png',
  bitmart: '/icons/exchanges/bitmart.png',
  etoro: '/icons/exchanges/etoro.png',
  woox: '/icons/exchanges/woox.png',
  polymarket: '/icons/exchanges/polymarket.png',
  copin: '/icons/exchanges/copin.png',
  // Aliases for DB source names (e.g. "binance_futures" -> binance logo)
  binance_futures: '/icons/exchanges/binance.png',
  binance_spot: '/icons/exchanges/binance.png',
  binance_web3: '/icons/exchanges/binance.png',
  bybit_spot: '/icons/exchanges/bybit.png',
  bitget_futures: '/icons/exchanges/bitget.png',
  bitget_spot: '/icons/exchanges/bitget.png',
  okx_futures: '/icons/exchanges/okx.png',
  okx_spot: '/icons/exchanges/okx.png',
  okx_web3: '/icons/exchanges/okx.png',
  okx_wallet: '/icons/exchanges/okx.png',
  htx_futures: '/icons/exchanges/htx.png',
  gateio: '/icons/exchanges/gate.png',
  jupiter_perps: '/icons/exchanges/jupiter.png',
  dune_gmx: '/icons/exchanges/gmx.png',
  dune_hyperliquid: '/icons/exchanges/hyperliquid.png',
  dune_uniswap: '/icons/exchanges/uniswap.png',
  dune_defi: '/icons/exchanges/uniswap.png',
  // Active sources that share a base exchange logo
  web3_bot: '/icons/exchanges/hyperliquid.png', // Web3 bot traders — use Hyperliquid as primary DEX icon
  bingx_spot: '/icons/exchanges/bingx.png',
  paradex: '/icons/exchanges/dydx.png', // Paradex is built on StarkEx (dYdX ecosystem)
}

export default function ExchangeLogo({ exchange, size = 24, className }: ExchangeLogoProps) {
  const [failed, setFailed] = useState(false)

  const logoUrl = LOCAL_LOGOS[exchange]

  if (logoUrl && !failed) {
    return (
      <Box
        style={{
          width: size,
          height: size,
          position: 'relative',
          flexShrink: 0,
        }}
        className={className}
      >
        <Image
          src={logoUrl}
          alt={`${exchange} logo`}
          width={size}
          height={size}
          sizes={`${size}px`}
          style={{
            objectFit: 'contain',
            borderRadius: tokens.radius.sm,
          }}
          onError={() => setFailed(true)}
        />
      </Box>
    )
  }

  // Generic fallback - first letter
  return (
    <Box
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: tokens.radius.sm,
        background: 'var(--color-bg-tertiary)',
        color: 'var(--color-text-secondary)',
        fontSize: size * 0.5,
        fontWeight: 700,
        flexShrink: 0,
      }}
      className={className}
    >
      {exchange.charAt(0).toUpperCase()}
    </Box>
  )
}
