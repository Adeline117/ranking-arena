'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

// 交易所显示名称映射
const EXCHANGE_LABELS: Record<string, string> = {
  binance_futures: 'Binance',
  bybit: 'Bybit',
  bitget_futures: 'Bitget',
  okx_futures: 'OKX',
  mexc: 'MEXC',
  kucoin: 'KuCoin',
  coinex: 'CoinEx',
  hyperliquid: 'Hyperliquid',
  gmx: 'GMX',
  dydx: 'dYdX',
  binance_spot: 'Binance Spot',
  bitget_spot: 'Bitget Spot',
  binance_web3: 'Binance Web3',
  okx_web3: 'OKX Web3',
}

interface ExchangeFilterProps {
  availableSources: string[]
  selectedExchange: string | null
  onExchangeChange: (exchange: string | null) => void
}

export default function ExchangeFilter({ availableSources, selectedExchange, onExchangeChange }: ExchangeFilterProps) {
  const { language } = useLanguage()

  if (!availableSources.length) return null

  // 只显示有数据的前 8 个交易所
  const visibleSources = availableSources.slice(0, 8)

  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexWrap: 'wrap' }}>
      <button
        onClick={() => onExchangeChange(null)}
        style={{
          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
          borderRadius: tokens.radius.full,
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: !selectedExchange ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
          color: !selectedExchange ? '#fff' : tokens.colors.text.tertiary,
          background: !selectedExchange ? tokens.colors.accent.primary : 'transparent',
          border: `1px solid ${!selectedExchange ? tokens.colors.accent.primary : tokens.colors.border.secondary}`,
          cursor: 'pointer',
          transition: `all ${tokens.transition.fast}`,
          whiteSpace: 'nowrap',
        }}
      >
        {language === 'zh' ? '全部' : 'All'}
      </button>
      {visibleSources.map((source) => {
        const isActive = selectedExchange === source
        const label = EXCHANGE_LABELS[source] || source.replace(/_/g, ' ')
        return (
          <button
            key={source}
            onClick={() => onExchangeChange(isActive ? null : source)}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.full,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
              color: isActive ? '#fff' : tokens.colors.text.tertiary,
              background: isActive ? tokens.colors.accent.primary : 'transparent',
              border: `1px solid ${isActive ? tokens.colors.accent.primary : tokens.colors.border.secondary}`,
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </button>
        )
      })}
    </Box>
  )
}
