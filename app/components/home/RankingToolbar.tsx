'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'
import TimeRangeSelector from './TimeRangeSelector'
import type { TimeRange } from './hooks/useTraderData'

interface RankingToolbarProps {
  activeTimeRange: TimeRange
  onTimeRangeChange: (range: TimeRange) => void
  loading: boolean
  onRefresh?: () => void
  onCopyLink: () => void
  language: string
  t: (key: string) => string
}

export default function RankingToolbar({
  activeTimeRange,
  onTimeRangeChange,
  loading,
  onRefresh,
  onCopyLink,
  language,
  t,
}: RankingToolbarProps) {
  return (
    <Box
      className="ranking-toolbar"
      style={{
        marginBottom: tokens.spacing[2],
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacing[2],
        flexWrap: 'wrap',
      }}
    >
      {/* 左侧: 时间选择 + 类型预设 + 平台下拉 */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
        <TimeRangeSelector
          activeRange={activeTimeRange}
          onChange={onTimeRangeChange}
          disabled={loading}
        />
      </Box>

      {/* 右侧: Pro 标签 + 操作按钮 */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexShrink: 0 }}>
        {BETA_PRO_FEATURES_FREE && (
          <Box style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            borderRadius: tokens.radius.md,
            background: 'color-mix(in srgb, var(--color-pro-gradient-start, #a78bfa) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-pro-gradient-start, #a78bfa) 25%, transparent)',
            fontSize: 11,
            color: 'var(--color-text-tertiary)',
            whiteSpace: 'nowrap',
          }}>
            <span style={{ fontWeight: 700, color: 'var(--color-pro-gradient-start, #a78bfa)' }}>Pro</span>
            <span>{language === 'zh' ? '限时免费' : 'Free beta'}</span>
          </Box>
        )}
        {/* Copy Filter Link Button */}
        {!loading && (
          <button
            className="btn-press"
            onClick={onCopyLink}
            aria-label={t('copyFilterLink') || 'Copy filter link'}
            title={t('copyFilterLink') || 'Copy filter link'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: tokens.radius.sm,
              background: tokens.glass.bg.light,
              border: `1px solid var(--color-border-primary)`,
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {!loading && onRefresh && (
          <button
            className="btn-press"
            onClick={onRefresh}
            aria-label={t('refreshData')}
            title={t('refreshData')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: tokens.radius.sm,
              background: tokens.glass.bg.light,
              border: `1px solid var(--color-border-primary)`,
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 4v6h6M23 20v-6h-6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {/* DataFreshnessIndicator removed from toolbar — bottom timestamp is less intrusive */}
      </Box>
    </Box>
  )
}
