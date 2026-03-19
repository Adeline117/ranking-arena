'use client'

import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { FilterConfig } from '../premium/AdvancedFilter'

const BottomSheet = dynamic(() => import('../ui/BottomSheet'), { ssr: false })

interface MobileFilterSheetProps {
  open: boolean
  onClose: () => void
  filterConfig: FilterConfig
  onFilterChange: (config: FilterConfig) => void
  onReset: () => void
  hasActiveFilters: boolean
}

/** Quick-access filter presets for mobile */
const QUICK_FILTERS: Array<{ i18nKey: string; config: FilterConfig }> = [
  { i18nKey: 'filterHighWinRate', config: { min_win_rate: 60 } },
  { i18nKey: 'filterLowDrawdown', config: { drawdown_max: 15 } },
  { i18nKey: 'filterHighRoi', config: { roi_min: 50 } },
  { i18nKey: 'filterHighScore', config: { min_score: 70 } },
  { i18nKey: 'filterSteadyProfit', config: { min_win_rate: 55, drawdown_max: 20, roi_min: 10 } },
]

export default function MobileFilterSheet({
  open,
  onClose,
  filterConfig,
  onFilterChange,
  onReset,
  hasActiveFilters,
}: MobileFilterSheetProps) {
  const { t } = useLanguage()

  const applyQuickFilter = (config: FilterConfig) => {
    onFilterChange({ ...filterConfig, ...config })
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('filterTitle')} initialSnap="half">
      {/* Quick filter chips */}
      <div style={{ marginBottom: tokens.spacing[4] }}>
        <div style={{ fontSize: tokens.typography.fontSize.sm, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[2] }}>
          {t('filterQuickFilters')}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
          {QUICK_FILTERS.map((qf, i) => (
            <button
              key={i}
              onClick={() => applyQuickFilter(qf.config)}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.full,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 500,
                border: `1px solid var(--color-border-primary)`,
                background: 'var(--color-bg-tertiary)',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
                minHeight: 36,
                transition: 'all 0.15s ease',
              }}
            >
              {t(qf.i18nKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Range filters */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        <FilterSlider
          label={t('filterMinRoi')}
          value={filterConfig.roi_min ?? 0}
          min={-100}
          max={500}
          step={5}
          onChange={(v) => onFilterChange({ ...filterConfig, roi_min: v || undefined })}
        />
        <FilterSlider
          label={t('filterMaxDrawdown')}
          value={filterConfig.drawdown_max ?? 100}
          min={0}
          max={100}
          step={5}
          onChange={(v) => onFilterChange({ ...filterConfig, drawdown_max: v < 100 ? v : undefined })}
        />
        <FilterSlider
          label={t('filterMinWinRate')}
          value={filterConfig.min_win_rate ?? 0}
          min={0}
          max={100}
          step={5}
          onChange={(v) => onFilterChange({ ...filterConfig, min_win_rate: v || undefined })}
        />
        <FilterSlider
          label={t('filterMinScore')}
          value={filterConfig.min_score ?? 0}
          min={0}
          max={100}
          step={5}
          onChange={(v) => onFilterChange({ ...filterConfig, min_score: v || undefined })}
        />
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: tokens.spacing[3], marginTop: tokens.spacing[6], paddingBottom: tokens.spacing[4] }}>
        {hasActiveFilters && (
          <button
            onClick={() => { onReset(); onClose() }}
            style={{
              flex: 1,
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              border: `1px solid var(--color-border-primary)`,
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              minHeight: 44,
            }}
          >
            {t('resetFilters')}
          </button>
        )}
        <button
          onClick={onClose}
          style={{
            flex: 2,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.lg,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: 700,
            border: 'none',
            background: `linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)`,
            color: '#fff',
            cursor: 'pointer',
            minHeight: 44,
          }}
        >
          {t('filterApply')}
        </button>
      </div>
    </BottomSheet>
  )
}

function FilterSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing[1] }}>
        <span style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)' }}>
          {label}
        </span>
        <span style={{ fontSize: tokens.typography.fontSize.sm, fontWeight: 600, color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: '100%',
          height: 6,
          accentColor: tokens.colors.accent.primary,
          cursor: 'pointer',
        }}
      />
    </div>
  )
}
