'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import PremiumGate, { ProLabel } from '../premium/PremiumGate'
import { DataOrPlaceholder } from '../ui/MissingDataPlaceholder'
import { DataSourceBadge } from '../ui/DataSourceTooltip'

// Icons
const CompareIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="18" rx="1" />
    <rect x="14" y="3" width="7" height="18" rx="1" />
  </svg>
)

const ArrowRightIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
)

const CheckCircleIcon = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <path d="M9 12l2 2 4-4" />
  </svg>
)

const XCircleIcon = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <path d="M15 9l-6 6M9 9l6 6" />
  </svg>
)

interface ExchangeData {
  exchange: string
  displayName: string
  roi?: number | null
  pnl?: number | null
  winRate?: number | null
  maxDrawdown?: number | null
  followers?: number | null
  arenaScore?: number | null
  lastUpdated?: string
  available: boolean
}

interface CrossExchangeComparisonProps {
  isPro: boolean
  isLoggedIn?: boolean
  /** Trader handle/ID being compared */
  traderId?: string
  traderHandle?: string
  /** Exchange data for the trader across different exchanges */
  exchangeData?: ExchangeData[]
}

/**
 * Cross-Exchange Comparison Component (Pro Only)
 * Shows the same trader's performance across different exchanges
 */
export default function CrossExchangeComparison({
  isPro,
  isLoggedIn = true,
  traderId,
  traderHandle,
  exchangeData = [],
}: CrossExchangeComparisonProps) {
  const { t, language } = useLanguage()
  const [selectedMetric, setSelectedMetric] = useState<'roi' | 'winRate' | 'maxDrawdown' | 'arenaScore'>('roi')

  // Demo data if no real data provided
  const demoData: ExchangeData[] = [
    {
      exchange: 'binance_futures',
      displayName: 'Binance Futures',
      roi: 156.8,
      pnl: 45600,
      winRate: 68.5,
      maxDrawdown: 12.3,
      followers: 1245,
      arenaScore: 78.5,
      lastUpdated: new Date().toISOString(),
      available: true,
    },
    {
      exchange: 'bybit',
      displayName: 'Bybit',
      roi: 142.3,
      pnl: null,
      winRate: 65.2,
      maxDrawdown: 15.8,
      followers: 890,
      arenaScore: 72.1,
      lastUpdated: new Date().toISOString(),
      available: true,
    },
    {
      exchange: 'bitget_futures',
      displayName: 'Bitget',
      roi: null,
      pnl: null,
      winRate: null,
      maxDrawdown: null,
      followers: null,
      arenaScore: null,
      lastUpdated: undefined,
      available: false,
    },
  ]

  const data = exchangeData.length > 0 ? exchangeData : demoData
  const availableData = data.filter(d => d.available)

  const formatValue = (value: number | null | undefined, type: string) => {
    if (value === null || value === undefined) return '—'

    switch (type) {
      case 'roi':
        return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
      case 'pnl':
        if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(2)}M`
        if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}K`
        return `$${value.toFixed(0)}`
      case 'winRate':
        return `${value.toFixed(1)}%`
      case 'maxDrawdown':
        return `-${Math.abs(value).toFixed(1)}%`
      case 'arenaScore':
        return value.toFixed(1)
      case 'followers':
        if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
        return value.toString()
      default:
        return value.toString()
    }
  }

  const getBestExchange = (metric: 'roi' | 'winRate' | 'maxDrawdown' | 'arenaScore') => {
    const validData = availableData.filter(d => d[metric] !== null && d[metric] !== undefined)
    if (validData.length === 0) return null

    return validData.reduce((best, current) => {
      const bestValue = best[metric] as number
      const currentValue = current[metric] as number

      if (metric === 'maxDrawdown') {
        // Lower is better for drawdown
        return Math.abs(currentValue) < Math.abs(bestValue) ? current : best
      }
      return currentValue > bestValue ? current : best
    })
  }

  const metrics = [
    { key: 'roi' as const, label: 'ROI', description: language === 'zh' ? '投资回报率' : 'Return on Investment' },
    { key: 'winRate' as const, label: language === 'zh' ? '胜率' : 'Win Rate', description: language === 'zh' ? '盈利交易占比' : 'Profitable trades percentage' },
    { key: 'maxDrawdown' as const, label: 'MDD', description: language === 'zh' ? '最大回撤' : 'Maximum Drawdown' },
    { key: 'arenaScore' as const, label: 'Score', description: language === 'zh' ? 'Arena Score 综合评分' : 'Arena Score' },
  ]

  const bestExchange = getBestExchange(selectedMetric)

  const content = (
    <Box>
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: tokens.spacing[4],
          flexWrap: 'wrap',
          gap: tokens.spacing[2],
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <CompareIcon size={18} />
          <Text size="md" weight="bold">
            {t('crossExchangeCompare')}
          </Text>
          <ProLabel size="xs" />
        </Box>
        {traderHandle && (
          <Text size="sm" color="secondary">
            {traderHandle}
          </Text>
        )}
      </Box>

      {/* Metric Selector */}
      <Box
        style={{
          display: 'flex',
          gap: tokens.spacing[2],
          marginBottom: tokens.spacing[4],
          flexWrap: 'wrap',
        }}
      >
        {metrics.map((metric) => (
          <button
            key={metric.key}
            onClick={() => setSelectedMetric(metric.key)}
            title={metric.description}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${
                selectedMetric === metric.key ? tokens.colors.accent.primary : tokens.colors.border.primary
              }`,
              background:
                selectedMetric === metric.key
                  ? `${tokens.colors.accent.primary}20`
                  : tokens.colors.bg.tertiary,
              color:
                selectedMetric === metric.key
                  ? tokens.colors.accent.primary
                  : tokens.colors.text.secondary,
              cursor: 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: selectedMetric === metric.key ? 600 : 400,
              transition: tokens.transition.fast,
            }}
          >
            {metric.label}
          </button>
        ))}
      </Box>

      {/* Comparison Table */}
      <Box
        style={{
          borderRadius: tokens.radius.lg,
          border: tokens.glass.border.light,
          overflow: 'hidden',
        }}
      >
        {/* Table Header */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 100px 80px 80px 60px',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            background: tokens.glass.bg.light,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
            {language === 'zh' ? '交易所' : 'Exchange'}
          </Text>
          <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase' }}>
            {metrics.find(m => m.key === selectedMetric)?.label}
          </Text>
          <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase' }}>
            {language === 'zh' ? '胜率' : 'Win%'}
          </Text>
          <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase' }}>
            MDD
          </Text>
          <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase' }}>
            {language === 'zh' ? '状态' : 'Status'}
          </Text>
        </Box>

        {/* Table Rows */}
        {data.map((item) => {
          const isBest = bestExchange?.exchange === item.exchange
          const metricValue = item[selectedMetric]

          return (
            <Box
              key={item.exchange}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 100px 80px 80px 60px',
                gap: tokens.spacing[2],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                alignItems: 'center',
                borderBottom: `1px solid var(--glass-border-light)`,
                background: isBest && item.available ? `${tokens.colors.accent.success}08` : 'transparent',
                opacity: item.available ? 1 : 0.5,
              }}
            >
              {/* Exchange */}
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                <Text size="sm" weight="semibold">
                  {item.displayName}
                </Text>
                {isBest && item.available && (
                  <Box
                    style={{
                      padding: '2px 6px',
                      borderRadius: tokens.radius.full,
                      background: `${tokens.colors.accent.success}20`,
                    }}
                  >
                    <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.success }}>
                      {language === 'zh' ? '最佳' : 'Best'}
                    </Text>
                  </Box>
                )}
              </Box>

              {/* Selected Metric Value */}
              <Text
                size="sm"
                weight="bold"
                style={{
                  textAlign: 'right',
                  color: item.available
                    ? selectedMetric === 'maxDrawdown'
                      ? tokens.colors.accent.error
                      : metricValue !== null && metricValue !== undefined && metricValue >= 0
                      ? tokens.colors.accent.success
                      : tokens.colors.text.primary
                    : tokens.colors.text.tertiary,
                }}
              >
                {item.available ? formatValue(metricValue, selectedMetric) : '—'}
              </Text>

              {/* Win Rate */}
              <Text
                size="sm"
                style={{
                  textAlign: 'right',
                  color: item.available ? tokens.colors.text.secondary : tokens.colors.text.tertiary,
                }}
              >
                {item.available ? formatValue(item.winRate, 'winRate') : '—'}
              </Text>

              {/* Max Drawdown */}
              <Text
                size="sm"
                style={{
                  textAlign: 'right',
                  color: item.available ? tokens.colors.accent.error : tokens.colors.text.tertiary,
                }}
              >
                {item.available ? formatValue(item.maxDrawdown, 'maxDrawdown') : '—'}
              </Text>

              {/* Status */}
              <Box style={{ display: 'flex', justifyContent: 'center' }}>
                {item.available ? (
                  <DataSourceBadge
                    availability="available"
                    exchange={item.exchange.split('_')[0]}
                    lastUpdated={item.lastUpdated}
                    compact
                  />
                ) : (
                  <DataSourceBadge availability="unavailable" compact />
                )}
              </Box>
            </Box>
          )
        })}
      </Box>

      {/* Summary */}
      {bestExchange && (
        <Box
          style={{
            marginTop: tokens.spacing[4],
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.lg,
            background: `${tokens.colors.accent.success}10`,
            border: `1px solid ${tokens.colors.accent.success}30`,
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
            <CheckCircleIcon size={16} color={tokens.colors.accent.success} />
            <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.success }}>
              {language === 'zh' ? '最佳表现交易所' : 'Best Performing Exchange'}
            </Text>
          </Box>
          <Text size="sm" color="secondary">
            {language === 'zh'
              ? `基于 ${metrics.find(m => m.key === selectedMetric)?.label}，${bestExchange.displayName} 表现最佳，达到 ${formatValue(bestExchange[selectedMetric], selectedMetric)}。`
              : `Based on ${metrics.find(m => m.key === selectedMetric)?.label}, ${bestExchange.displayName} performs best with ${formatValue(bestExchange[selectedMetric], selectedMetric)}.`}
          </Text>
        </Box>
      )}

      {/* No Data Message */}
      {availableData.length === 0 && (
        <Box
          style={{
            padding: tokens.spacing[6],
            textAlign: 'center',
          }}
        >
          <Text color="tertiary">
            {language === 'zh'
              ? '此交易员暂无跨交易所数据'
              : 'No cross-exchange data available for this trader'}
          </Text>
        </Box>
      )}
    </Box>
  )

  return (
    <PremiumGate
      isPro={isPro}
      isLoggedIn={isLoggedIn}
      featureName={t('crossExchangeCompare')}
      blurAmount={10}
      minHeight={300}
    >
      {content}
    </PremiumGate>
  )
}
