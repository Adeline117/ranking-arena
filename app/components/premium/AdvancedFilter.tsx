'use client'

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { SOURCES_WITH_DATA, EXCHANGE_CONFIG } from '@/lib/constants/exchanges'

// Sub-components
import { FilterChipGroup, GradeChipGroup } from './FilterChipGroup'
import { FilterRangeInput, FilterNumberInput } from './FilterRangeInput'
import { SavedFiltersList } from './SavedFiltersList'

// ── Types ──────────────────────────────────────────────────────────────────

export interface FilterConfig {
  category?: string[]
  exchange?: string[]
  roi_min?: number
  roi_max?: number
  drawdown_min?: number
  drawdown_max?: number
  period?: '7D' | '30D' | '90D'
  min_pnl?: number
  min_score?: number
  min_win_rate?: number
  grade?: string
}

export interface SavedFilter {
  id: string
  name: string
  description?: string
  filter_config: FilterConfig
  is_default?: boolean
  use_count?: number
  last_used_at?: string
  created_at?: string
}

interface AdvancedFilterProps {
  currentFilter: FilterConfig
  savedFilters: SavedFilter[]
  onFilterChange: (filter: FilterConfig) => void
  onSaveFilter?: (name: string, description?: string) => Promise<void>
  onLoadFilter: (filter: SavedFilter) => void
  onDeleteFilter: (filterId: string) => Promise<void>
  isPro: boolean
}

// ── Derived constants ──────────────────────────────────────────────────────

const EXCHANGES: { value: string; label: string }[] = (() => {
  const unique = [...new Set(SOURCES_WITH_DATA)]
  return unique.map(src => ({
    value: src,
    label: EXCHANGE_CONFIG[src]?.name || src,
  }))
})()

const CATEGORY_KEYS = [
  { value: 'futures', labelKey: 'categoryFutures' as const },
  { value: 'spot', labelKey: 'categorySpot' as const },
  { value: 'web3', labelKey: 'categoryWeb3' as const },
]

// ── Component ──────────────────────────────────────────────────────────────

export default function AdvancedFilter({
  currentFilter,
  savedFilters,
  onFilterChange,
  onLoadFilter,
  onDeleteFilter,
  isPro,
}: AdvancedFilterProps) {
  const { t } = useLanguage()
  const [isExpanded, setIsExpanded] = useState(true)

  const updateFilter = useCallback((key: keyof FilterConfig, value: unknown) => {
    onFilterChange({ ...currentFilter, [key]: value })
  }, [currentFilter, onFilterChange])

  const toggleArrayItem = useCallback((key: 'category' | 'exchange', value: string) => {
    const current = currentFilter[key] || []
    const newValue = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value]
    onFilterChange({ ...currentFilter, [key]: newValue.length > 0 ? newValue : undefined })
  }, [currentFilter, onFilterChange])

  const resetFilter = useCallback(() => {
    onFilterChange({})
  }, [onFilterChange])

  const hasActiveFilters = Object.keys(currentFilter).some(key => {
    const value = currentFilter[key as keyof FilterConfig]
    if (Array.isArray(value)) return value.length > 0
    return value != null
  })

  // Non-Pro: grade filter only + upgrade prompt
  if (!isPro) {
    return (
      <Box
        style={{
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
          overflow: 'hidden',
        }}
      >
        <Box style={{ padding: tokens.spacing[4] }}>
          <GradeChipGroup
            label={t('grade')}
            selectedGrade={currentFilter.grade}
            onSelectGrade={(g) => onFilterChange({ ...currentFilter, grade: g })}
          />
          <Box
            style={{
              padding: tokens.spacing[3],
              background: `linear-gradient(135deg, ${tokens.colors.accent.primary}10 0%, ${tokens.colors.accent.brand}08 100%)`,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.accent.primary}20`,
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Text size="sm" weight="bold">{t('advancedFilterLocked')}</Text>
                <Text size="xs" color="tertiary">{t('unlockAdvancedFilter')}</Text>
              </Box>
              <Button variant="secondary" size="sm" onClick={() => window.location.href = '/settings'}>
                {t('upgrade')}
              </Button>
            </Box>
          </Box>
        </Box>
      </Box>
    )
  }

  return (
    <Box
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Box
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: tokens.spacing[4],
          cursor: 'pointer',
          background: hasActiveFilters ? `${tokens.colors.accent.primary}10` : 'transparent',
          transition: 'background 0.2s',
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="bold">{t('advancedFilter')}</Text>
          {hasActiveFilters && (
            <Box
              style={{
                padding: `2px 8px`,
                borderRadius: tokens.radius.full,
                background: tokens.colors.accent.primary,
                color: tokens.colors.white,
                fontSize: 10,
                fontWeight: 'bold',
              }}
            >
              {t('filtered')}
            </Box>
          )}
        </Box>
        <Text size="sm" color="tertiary">{isExpanded ? '\u25B2' : '\u25BC'}</Text>
      </Box>

      {/* Expanded content */}
      {isExpanded && (
        <Box style={{ padding: tokens.spacing[4], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
          {/* Saved filters */}
          <SavedFiltersList
            label={t('savedFilters')}
            savedFilters={savedFilters}
            onLoadFilter={onLoadFilter}
            onDeleteFilter={onDeleteFilter}
          />

          {/* Grade */}
          <GradeChipGroup
            label={t('grade')}
            selectedGrade={currentFilter.grade}
            onSelectGrade={(g) => onFilterChange({ ...currentFilter, grade: g })}
          />

          {/* Category */}
          <FilterChipGroup
            label={t('categoryType')}
            items={CATEGORY_KEYS.map(cat => ({ value: cat.value, label: t(cat.labelKey) }))}
            selected={currentFilter.category}
            onToggle={(v) => toggleArrayItem('category', v)}
          />

          {/* Exchange */}
          <FilterChipGroup
            label={t('exchange')}
            items={EXCHANGES}
            selected={currentFilter.exchange}
            onToggle={(v) => toggleArrayItem('exchange', v)}
            compact
          />

          {/* ROI range */}
          <FilterRangeInput
            label={t('roiRange')}
            minValue={currentFilter.roi_min}
            maxValue={currentFilter.roi_max}
            onMinChange={(v) => updateFilter('roi_min', v)}
            onMaxChange={(v) => updateFilter('roi_max', v)}
            minPlaceholder={t('min')}
            maxPlaceholder={t('max')}
            min={-100}
            max={100000}
          />

          {/* Drawdown range */}
          <FilterRangeInput
            label={t('drawdownRange')}
            minValue={currentFilter.drawdown_min}
            maxValue={currentFilter.drawdown_max}
            onMinChange={(v) => updateFilter('drawdown_min', v)}
            onMaxChange={(v) => updateFilter('drawdown_max', v)}
            minPlaceholder={t('min')}
            maxPlaceholder={t('max')}
            min={0}
            max={100}
          />

          {/* Other thresholds */}
          <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
            <FilterNumberInput
              label={t('minPnl')}
              placeholder={`${t('egExample')} 1000`}
              value={currentFilter.min_pnl}
              onChange={(v) => updateFilter('min_pnl', v)}
            />
            <FilterNumberInput
              label={t('minScore')}
              placeholder={`${t('egExample')} 40`}
              value={currentFilter.min_score}
              onChange={(v) => updateFilter('min_score', v)}
            />
            <FilterNumberInput
              label={t('minWinRate')}
              placeholder={`${t('egExample')} 50`}
              value={currentFilter.min_win_rate}
              onChange={(v) => updateFilter('min_win_rate', v)}
            />
          </Box>

          {/* Action buttons */}
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              onClick={resetFilter}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: 'transparent',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              {t('resetFilter')}
            </button>
          </Box>
        </Box>
      )}
    </Box>
  )
}
