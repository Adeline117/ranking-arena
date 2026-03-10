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
const QUICK_FILTERS: Array<{ labelZh: string; labelEn: string; config: FilterConfig }> = [
  { labelZh: '高胜率', labelEn: 'High Win Rate', config: { min_win_rate: 60 } },
  { labelZh: '低回撤', labelEn: 'Low Drawdown', config: { drawdown_max: 15 } },
  { labelZh: '高收益', labelEn: 'High ROI', config: { roi_min: 50 } },
  { labelZh: '高分', labelEn: 'High Score', config: { min_score: 70 } },
  { labelZh: '稳定盈利', labelEn: 'Steady Profit', config: { min_win_rate: 55, drawdown_max: 20, roi_min: 10 } },
]

export default function MobileFilterSheet({
  open,
  onClose,
  filterConfig,
  onFilterChange,
  onReset,
  hasActiveFilters,
}: MobileFilterSheetProps) {
  const { language, t } = useLanguage()

  const applyQuickFilter = (config: FilterConfig) => {
    onFilterChange({ ...filterConfig, ...config })
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={language === 'zh' ? '筛选' : 'Filters'} initialSnap="half">
      {/* Quick filter chips */}
      <div style={{ marginBottom: tokens.spacing[4] }}>
        <div style={{ fontSize: tokens.typography.fontSize.sm, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[2] }}>
          {language === 'zh' ? '快速筛选' : 'Quick Filters'}
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
              {language === 'zh' ? qf.labelZh : qf.labelEn}
            </button>
          ))}
        </div>
      </div>

      {/* Range filters */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        <FilterSlider
          label={language === 'zh' ? '最低 ROI (%)' : 'Min ROI (%)'}
          value={filterConfig.roi_min ?? 0}
          min={-100}
          max={500}
          step={5}
          onChange={(v) => onFilterChange({ ...filterConfig, roi_min: v || undefined })}
        />
        <FilterSlider
          label={language === 'zh' ? '最大回撤 (%)' : 'Max Drawdown (%)'}
          value={filterConfig.drawdown_max ?? 100}
          min={0}
          max={100}
          step={5}
          onChange={(v) => onFilterChange({ ...filterConfig, drawdown_max: v < 100 ? v : undefined })}
        />
        <FilterSlider
          label={language === 'zh' ? '最低胜率 (%)' : 'Min Win Rate (%)'}
          value={filterConfig.min_win_rate ?? 0}
          min={0}
          max={100}
          step={5}
          onChange={(v) => onFilterChange({ ...filterConfig, min_win_rate: v || undefined })}
        />
        <FilterSlider
          label={language === 'zh' ? '最低 Arena Score' : 'Min Arena Score'}
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
            {t('resetFilters') || (language === 'zh' ? '重置' : 'Reset')}
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
          {language === 'zh' ? '应用筛选' : 'Apply Filters'}
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
