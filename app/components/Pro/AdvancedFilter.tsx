'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'
import { useLanguage } from '../Utils/LanguageProvider'

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
  onSaveFilter: (name: string, description?: string) => Promise<void>
  onLoadFilter: (filter: SavedFilter) => void
  onDeleteFilter: (filterId: string) => Promise<void>
  isPro: boolean
}

// 交易所选项
const EXCHANGES = [
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'bitget', label: 'Bitget' },
  { value: 'okx', label: 'OKX' },
  { value: 'mexc', label: 'MEXC' },
  { value: 'coinex', label: 'CoinEx' },
  { value: 'kucoin', label: 'KuCoin' },
  { value: 'gmx', label: 'GMX' },
]

// 类型选项 - 使用 i18n key
const CATEGORY_KEYS = [
  { value: 'futures', labelKey: 'categoryFutures' as const },
  { value: 'spot', labelKey: 'categorySpot' as const },
  { value: 'web3', labelKey: 'categoryWeb3' as const },
]

// 周期选项 - 使用 i18n key
const PERIOD_KEYS = [
  { value: '7D', labelKey: 'period7D' as const },
  { value: '30D', labelKey: 'period30D' as const },
  { value: '90D', labelKey: 'period90D' as const },
]

export default function AdvancedFilter({
  currentFilter,
  savedFilters,
  onFilterChange,
  onSaveFilter,
  onLoadFilter,
  onDeleteFilter,
  isPro,
}: AdvancedFilterProps) {
  const { t } = useLanguage()
  const [isExpanded, setIsExpanded] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDescription, setSaveDescription] = useState('')
  const [saving, setSaving] = useState(false)

  // 更新筛选条件
  const updateFilter = (key: keyof FilterConfig, value: any) => {
    onFilterChange({ ...currentFilter, [key]: value })
  }

  // 切换多选项
  const toggleArrayItem = (key: 'category' | 'exchange', value: string) => {
    const current = currentFilter[key] || []
    const newValue = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value]
    updateFilter(key, newValue.length > 0 ? newValue : undefined)
  }

  // 重置筛选
  const resetFilter = () => {
    onFilterChange({})
  }

  // 保存筛选
  const handleSave = async () => {
    if (!saveName.trim()) return
    setSaving(true)
    try {
      await onSaveFilter(saveName.trim(), saveDescription.trim() || undefined)
      setShowSaveModal(false)
      setSaveName('')
      setSaveDescription('')
    } finally {
      setSaving(false)
    }
  }

  // 检查是否有活动筛选
  const hasActiveFilters = Object.keys(currentFilter).some(key => {
    const value = currentFilter[key as keyof FilterConfig]
    if (Array.isArray(value)) return value.length > 0
    return value != null
  })

  if (!isPro) {
    return (
      <Box
        style={{
          padding: tokens.spacing[4],
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
                color: '#fff',
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
                    <button
                      onClick={() => onDeleteFilter(filter.id)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: tokens.colors.text.tertiary,
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: 0,
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

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
                value={currentFilter.roi_min ?? ''}
                onChange={(e) => updateFilter('roi_min', e.target.value ? Number(e.target.value) : undefined)}
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
                value={currentFilter.roi_max ?? ''}
                onChange={(e) => updateFilter('roi_max', e.target.value ? Number(e.target.value) : undefined)}
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
                value={currentFilter.drawdown_min ?? ''}
                onChange={(e) => updateFilter('drawdown_min', e.target.value ? Number(e.target.value) : undefined)}
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
                value={currentFilter.drawdown_max ?? ''}
                onChange={(e) => updateFilter('drawdown_max', e.target.value ? Number(e.target.value) : undefined)}
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
            {hasActiveFilters && (
              <button
                onClick={() => setShowSaveModal(true)}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.accent.primary}`,
                  background: `${tokens.colors.accent.primary}15`,
                  color: tokens.colors.accent.primary,
                  cursor: 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.bold,
                }}
              >
                {t('saveFilter')}
              </button>
            )}
          </Box>
        </Box>
      )}

      {/* 保存筛选弹窗 */}
      {showSaveModal && (
        <Box
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: tokens.zIndex.modal,
          }}
          onClick={() => setShowSaveModal(false)}
        >
          <Box
            onClick={e => e.stopPropagation()}
            style={{
              width: 400,
              maxWidth: '90vw',
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}`,
              padding: tokens.spacing[6],
            }}
          >
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
              {t('saveFilterConfig')}
            </Text>

            <Box style={{ marginBottom: tokens.spacing[3] }}>
              <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                {t('filterName')} *
              </Text>
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder={t('filterNamePlaceholder')}
                maxLength={50}
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
            </Box>

            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                {t('filterDescription')}
              </Text>
              <textarea
                value={saveDescription}
                onChange={(e) => setSaveDescription(e.target.value)}
                placeholder={t('filterDescPlaceholder')}
                rows={2}
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                  resize: 'none',
                }}
              />
            </Box>

            <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: tokens.spacing[2] }}>
              <Button variant="secondary" onClick={() => setShowSaveModal(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={!saveName.trim() || saving}
              >
                {saving ? t('saving') : t('save')}
              </Button>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  )
}
