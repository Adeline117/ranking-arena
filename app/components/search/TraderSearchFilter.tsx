'use client'

import { useCallback, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

export interface TraderFilterConfig {
  exchange?: string[]
  roi_min?: number
  roi_max?: number
  min_score?: number
  period?: '7D' | '30D' | '90D'
}

interface TraderSearchFilterProps {
  filter: TraderFilterConfig
  onFilterChange: (filter: TraderFilterConfig) => void
  isVisible: boolean
  onToggle: () => void
}

const EXCHANGES = [
  // CEX - Top tier
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'bitget', label: 'Bitget' },
  { value: 'okx', label: 'OKX' },
  { value: 'mexc', label: 'MEXC' },
  { value: 'kucoin', label: 'KuCoin' },
  { value: 'htx', label: 'HTX' },
  { value: 'coinex', label: 'CoinEx' },
  // DEX
  { value: 'gmx', label: 'GMX' },
  { value: 'hyperliquid', label: 'Hyperliquid' },
]

const PERIOD_OPTIONS = [
  { value: '7D', label: '7D' },
  { value: '30D', label: '30D' },
  { value: '90D', label: '90D' },
]

export function TraderSearchFilter({
  filter,
  onFilterChange,
  isVisible,
  onToggle,
}: TraderSearchFilterProps) {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const updateFilter = useCallback((key: keyof TraderFilterConfig, value: unknown) => {
    onFilterChange({ ...filter, [key]: value })
  }, [filter, onFilterChange])

  const toggleExchange = useCallback((exchange: string) => {
    const current = filter.exchange || []
    const newValue = current.includes(exchange)
      ? current.filter(e => e !== exchange)
      : [...current, exchange]
    onFilterChange({ ...filter, exchange: newValue.length > 0 ? newValue : undefined })
  }, [filter, onFilterChange])

  const resetFilter = useCallback(() => {
    onFilterChange({})
  }, [onFilterChange])

  const hasActiveFilters = useMemo(() => {
    return Object.keys(filter).some(key => {
      const value = filter[key as keyof TraderFilterConfig]
      if (Array.isArray(value)) return value.length > 0
      return value != null
    })
  }, [filter])

  const activeFilterCount = useMemo(() => {
    let count = 0
    if (filter.exchange?.length) count++
    if (filter.roi_min != null || filter.roi_max != null) count++
    if (filter.min_score != null) count++
    if (filter.period) count++
    return count
  }, [filter])

  return (
    <Box style={{ marginBottom: tokens.spacing[4] }}>
      {/* Filter Toggle Button */}
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.lg,
          border: hasActiveFilters
            ? `1px solid ${tokens.colors.accent.primary}40`
            : `1px solid ${tokens.colors.border.primary}`,
          background: hasActiveFilters
            ? `${tokens.colors.accent.primary}15`
            : tokens.colors.bg.secondary,
          color: hasActiveFilters
            ? tokens.colors.accent.primary
            : tokens.colors.text.secondary,
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.semibold,
          cursor: 'pointer',
          transition: tokens.transition.base,
        }}
      >
        <span style={{ fontSize: 14 }}>Settings</span>
        <span>{isZh ? '高级筛选' : 'Advanced Filter'}</span>
        {activeFilterCount > 0 && (
          <span
            style={{
              padding: '2px 6px',
              borderRadius: tokens.radius.full,
              background: tokens.colors.accent.primary,
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            {activeFilterCount}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12 }}>
          {isVisible ? '▲' : '▼'}
        </span>
      </button>

      {/* Filter Panel */}
      {isVisible && (
        <Box
          className="page-enter-fast"
          style={{
            marginTop: tokens.spacing[3],
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
            boxShadow: tokens.shadow.md,
          }}
        >
          {/* Period Selection */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              {isZh ? '时间周期' : 'Time Period'}
            </Text>
            <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
              {PERIOD_OPTIONS.map(option => {
                const isSelected = filter.period === option.value
                return (
                  <button
                    key={option.value}
                    onClick={() => updateFilter('period', isSelected ? undefined : option.value)}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                      borderRadius: tokens.radius.md,
                      minHeight: 40,
                      border: `1px solid ${isSelected ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                      background: isSelected ? `${tokens.colors.accent.primary}20` : 'transparent',
                      color: isSelected ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: isSelected ? 700 : 500,
                      cursor: 'pointer',
                      transition: tokens.transition.base,
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </Box>
          </Box>

          {/* Exchange Filter */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              {isZh ? '交易所' : 'Exchange'}
            </Text>
            <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
              {EXCHANGES.map(ex => {
                const isSelected = filter.exchange?.includes(ex.value)
                return (
                  <button
                    key={ex.value}
                    onClick={() => toggleExchange(ex.value)}
                    style={{
                      padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                      borderRadius: tokens.radius.sm,
                      border: `1px solid ${isSelected ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                      background: isSelected ? `${tokens.colors.accent.primary}15` : 'transparent',
                      color: isSelected ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                      fontSize: tokens.typography.fontSize.xs,
                      cursor: 'pointer',
                      transition: tokens.transition.base,
                    }}
                  >
                    {ex.label}
                  </button>
                )
              })}
            </Box>
          </Box>

          {/* ROI Range */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              {isZh ? 'ROI 范围 (%)' : 'ROI Range (%)'}
            </Text>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <input
                type="number"
                placeholder={isZh ? '最小' : 'Min'}
                value={filter.roi_min ?? ''}
                onChange={(e) => updateFilter('roi_min', e.target.value ? Number(e.target.value) : undefined)}
                className="input-focus-glow"
                style={{
                  width: 80,
                  padding: tokens.spacing[2],
                  minHeight: 40,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
              <Text size="sm" color="tertiary">~</Text>
              <input
                type="number"
                placeholder={isZh ? '最大' : 'Max'}
                value={filter.roi_max ?? ''}
                onChange={(e) => updateFilter('roi_max', e.target.value ? Number(e.target.value) : undefined)}
                className="input-focus-glow"
                style={{
                  width: 80,
                  padding: tokens.spacing[2],
                  minHeight: 40,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
            </Box>
          </Box>

          {/* Min Arena Score */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              {isZh ? '最低 Arena Score' : 'Min Arena Score'}
            </Text>
            <input
              type="number"
              placeholder={isZh ? '例如: 40' : 'e.g. 40'}
              value={filter.min_score ?? ''}
              onChange={(e) => updateFilter('min_score', e.target.value ? Number(e.target.value) : undefined)}
              className="input-focus-glow"
              style={{
                width: 120,
                padding: tokens.spacing[2],
                minHeight: 40,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                outline: 'none',
              }}
            />
          </Box>

          {/* Reset Button */}
          {hasActiveFilters && (
            <button
              onClick={resetFilter}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                minHeight: 40,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: 'transparent',
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                cursor: 'pointer',
                transition: tokens.transition.base,
              }}
            >
              {isZh ? '重置筛选' : 'Reset Filter'}
            </button>
          )}
        </Box>
      )}
    </Box>
  )
}

export default TraderSearchFilter
