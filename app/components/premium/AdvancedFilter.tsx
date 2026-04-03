'use client'

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { SOURCES_WITH_DATA, EXCHANGE_CONFIG } from '@/lib/constants/exchanges'

// 筛选配置类型
export interface FilterConfig {
  category?: string[]      // 类型：futures, spot, web3
  exchange?: string[]      // 交易所
  roi_min?: number         // 最小 ROI
  roi_max?: number         // 最大 ROI
  drawdown_min?: number    // 最小回撤
  drawdown_max?: number    // 最大回撤
  period?: '7D' | '30D' | '90D'  // 周期
  min_pnl?: number         // 最小 PnL
  min_score?: number       // 最小 Arena Score
  min_win_rate?: number    // 最小胜率
  grade?: string           // 等级：S, A, B, C, D
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
  onSaveFilter?: (name: string, description?: string) => Promise<void>  // Optional - filters are session-only
  onLoadFilter: (filter: SavedFilter) => void
  onDeleteFilter: (filterId: string) => Promise<void>
  isPro: boolean
}

// 交易所选项 -- derived from SOURCES_WITH_DATA to stay in sync with DB
const EXCHANGES: { value: string; label: string }[] = (() => {
  const unique = [...new Set(SOURCES_WITH_DATA)];
  return unique.map(src => ({
    value: src,
    label: EXCHANGE_CONFIG[src]?.name || src,
  }));
})()

// 类型选项 - 使用 i18n key
const CATEGORY_KEYS = [
  { value: 'futures', labelKey: 'categoryFutures' as const },
  { value: 'spot', labelKey: 'categorySpot' as const },
  { value: 'web3', labelKey: 'categoryWeb3' as const },
]

// 周期选项 - 使用 i18n key
const _PERIOD_KEYS = [
  { value: '7D', labelKey: 'period7D' as const },
  { value: '30D', labelKey: 'period30D' as const },
  { value: '90D', labelKey: 'period90D' as const },
]

export default function AdvancedFilter({
  currentFilter,
  savedFilters,
  onFilterChange,
  // onSaveFilter - removed, filters are session-only
  onLoadFilter,
  onDeleteFilter,
  isPro,
}: AdvancedFilterProps) {
  const { t, language: _language } = useLanguage()
  const [isExpanded, setIsExpanded] = useState(true)
  // Save filter states removed - filters are session-only

  // 更新筛选条件
  const updateFilter = useCallback((key: keyof FilterConfig, value: unknown) => {
    onFilterChange({ ...currentFilter, [key]: value })
  }, [currentFilter, onFilterChange])

  // 切换多选项
  const toggleArrayItem = useCallback((key: 'category' | 'exchange', value: string) => {
    const current = currentFilter[key] || []
    const newValue = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value]
    onFilterChange({ ...currentFilter, [key]: newValue.length > 0 ? newValue : undefined })
  }, [currentFilter, onFilterChange])

  // 重置筛选
  const resetFilter = useCallback(() => {
    onFilterChange({})
  }, [onFilterChange])

  // 检查是否有活动筛选
  const hasActiveFilters = Object.keys(currentFilter).some(key => {
    const value = currentFilter[key as keyof FilterConfig]
    if (Array.isArray(value)) return value.length > 0
    return value != null
  })

  // Grade filter section — available to ALL users
  const gradeSection = (
    <Box style={{ marginBottom: tokens.spacing[4] }}>
      <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
        {t('grade')}
      </Text>
      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
        {['S', 'A', 'B', 'C', 'D'].map(g => {
          const isSelected = currentFilter.grade === g
          return (
            <button
              key={g}
              onClick={() => onFilterChange({ ...currentFilter, grade: isSelected ? undefined : g })}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${isSelected ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                background: isSelected ? `${tokens.colors.accent.primary}20` : 'transparent',
                color: isSelected ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: isSelected ? 700 : 500,
                transition: 'all 0.2s',
                minWidth: 36,
              }}
            >
              {g}
            </button>
          )
        })}
      </Box>
    </Box>
  )

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
          {gradeSection}
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
      {/* 头部 */}
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
          <Text size="sm" weight="bold">
            {t('advancedFilter')}
          </Text>
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
        <Text size="sm" color="tertiary">
          {isExpanded ? '▲' : '▼'}
        </Text>
      </Box>

      {/* 展开内容 */}
      {isExpanded && (
        <Box style={{ padding: tokens.spacing[4], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
          {/* 已保存的筛选配置 */}
          {savedFilters.length > 0 && (
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                {t('savedFilters')}
              </Text>
              <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
                {savedFilters.map(filter => (
                  <Box
                    key={filter.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[1],
                      padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                      background: tokens.colors.bg.tertiary,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <button
                      onClick={() => onLoadFilter(filter)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: tokens.colors.text.primary,
                        cursor: 'pointer',
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: tokens.typography.fontWeight.semibold,
                      }}
                    >
                      {filter.name}
                    </button>
                    <button aria-label="Close"
                      onClick={() => onDeleteFilter(filter.id)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: tokens.colors.text.tertiary,
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: 0,
                        lineHeight: 1.2,
                      }}
                    >
                      ×
                    </button>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          {/* 等级筛选 — available to all */}
          {gradeSection}

          {/* 类型筛选 */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              {t('categoryType')}
            </Text>
            <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
              {CATEGORY_KEYS.map(cat => {
                const isSelected = currentFilter.category?.includes(cat.value)
                return (
                  <button
                    key={cat.value}
                    onClick={() => toggleArrayItem('category', cat.value)}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${isSelected ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                      background: isSelected ? `${tokens.colors.accent.primary}20` : 'transparent',
                      color: isSelected ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: isSelected ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                      transition: 'all 0.2s',
                    }}
                  >
                    {t(cat.labelKey)}
                  </button>
                )
              })}
            </Box>
          </Box>

          {/* 交易所筛选 */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              {t('exchange')}
            </Text>
            <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
              {EXCHANGES.map(ex => {
                const isSelected = currentFilter.exchange?.includes(ex.value)
                return (
                  <button
                    key={ex.value}
                    onClick={() => toggleArrayItem('exchange', ex.value)}
                    style={{
                      padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                      borderRadius: tokens.radius.sm,
                      border: `1px solid ${isSelected ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                      background: isSelected ? `${tokens.colors.accent.primary}15` : 'transparent',
                      color: isSelected ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.xs,
                      transition: 'all 0.2s',
                    }}
                  >
                    {ex.label}
                  </button>
                )
              })}
            </Box>
          </Box>

          {/* ROI 区间 */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              {t('roiRange')}
            </Text>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <input
                type="number"
                placeholder={t('min')}
                aria-label={`${t('roiRange')} ${t('min')}`}
                min={-100}
                max={100000}
                step="any"
                value={currentFilter.roi_min ?? ''}
                onChange={(e) => { const v = parseFloat(e.target.value); updateFilter('roi_min', e.target.value && !isNaN(v) ? v : undefined) }}
                style={{
                  width: 80,
                  padding: tokens.spacing[2],
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
                placeholder={t('max')}
                aria-label={`${t('roiRange')} ${t('max')}`}
                min={-100}
                max={100000}
                step="any"
                value={currentFilter.roi_max ?? ''}
                onChange={(e) => { const v = parseFloat(e.target.value); updateFilter('roi_max', e.target.value && !isNaN(v) ? v : undefined) }}
                style={{
                  width: 80,
                  padding: tokens.spacing[2],
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

          {/* 回撤区间 */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              {t('drawdownRange')}
            </Text>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <input
                type="number"
                placeholder={t('min')}
                aria-label={`${t('drawdownRange')} ${t('min')}`}
                min={0}
                max={100}
                step="any"
                value={currentFilter.drawdown_min ?? ''}
                onChange={(e) => { const v = parseFloat(e.target.value); updateFilter('drawdown_min', e.target.value && !isNaN(v) ? v : undefined) }}
                style={{
                  width: 80,
                  padding: tokens.spacing[2],
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
                placeholder={t('max')}
                aria-label={`${t('drawdownRange')} ${t('max')}`}
                min={0}
                max={100}
                step="any"
                value={currentFilter.drawdown_max ?? ''}
                onChange={(e) => { const v = parseFloat(e.target.value); updateFilter('drawdown_max', e.target.value && !isNaN(v) ? v : undefined) }}
                style={{
                  width: 80,
                  padding: tokens.spacing[2],
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

          {/* 其他条件 */}
          <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
            <Box>
              <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                {t('minPnl')}
              </Text>
              <input
                type="number"
                placeholder={`${t('egExample')} 1000`}
                aria-label={t('minPnl')}
                value={currentFilter.min_pnl ?? ''}
                onChange={(e) => updateFilter('min_pnl', e.target.value ? Number(e.target.value) : undefined)}
                style={{
                  width: '100%',
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
            </Box>
            <Box>
              <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                {t('minScore')}
              </Text>
              <input
                type="number"
                placeholder={`${t('egExample')} 40`}
                aria-label={t('minScore')}
                value={currentFilter.min_score ?? ''}
                onChange={(e) => updateFilter('min_score', e.target.value ? Number(e.target.value) : undefined)}
                style={{
                  width: '100%',
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
            </Box>
            <Box>
              <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                {t('minWinRate')}
              </Text>
              <input
                type="number"
                placeholder={`${t('egExample')} 50`}
                aria-label={t('minWinRate')}
                value={currentFilter.min_win_rate ?? ''}
                onChange={(e) => updateFilter('min_win_rate', e.target.value ? Number(e.target.value) : undefined)}
                style={{
                  width: '100%',
                  padding: tokens.spacing[2],
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

          {/* 操作按钮 */}
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
            {/* Save filter button removed - filters are session-only */}
          </Box>
        </Box>
      )}

      {/* Save filter modal removed - filters are session-only */}
    </Box>
  )
}
