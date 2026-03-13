'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import type { FilterConfig } from '../premium/AdvancedFilter'

interface FilterStatusMessagesProps {
  loading: boolean
  language: string
  selectedExchange: string | null
  advancedFilteredCount: number
  tradersCount: number
  hasActiveFilters: boolean
  onResetFilters: () => void
}

export default function FilterStatusMessages({
  loading,
  language,
  selectedExchange,
  advancedFilteredCount,
  tradersCount,
  hasActiveFilters,
  onResetFilters,
}: FilterStatusMessagesProps) {
  return (
    <>
      {/* Exchange trader count hint */}
      {!loading && selectedExchange && advancedFilteredCount > 0 && advancedFilteredCount < 20 && (
        <Box style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          marginBottom: tokens.spacing[2],
          textAlign: 'center',
          fontSize: tokens.typography.fontSize.sm,
          color: 'var(--color-text-tertiary)',
          background: tokens.glass.bg.light,
          borderRadius: tokens.radius.md,
        }}>
          {language === 'zh'
            ? `该平台共 ${advancedFilteredCount} 名交易员`
            : `${advancedFilteredCount} traders on this exchange`}
        </Box>
      )}

      {/* Show reset prompt when all traders filtered out by advanced filter */}
      {!loading && advancedFilteredCount === 0 && tradersCount > 0 && hasActiveFilters && (
        <Box style={{
          padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
          marginBottom: tokens.spacing[2],
          textAlign: 'center',
          background: tokens.glass.bg.light,
          borderRadius: tokens.radius.md,
          border: `1px solid var(--color-border-primary)`,
        }}>
          <Text size="sm" style={{ color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[2], display: 'block' }}>
            {language === 'zh'
              ? '当前筛选条件过滤了所有交易员'
              : 'All traders have been filtered out'}
          </Text>
          <button
            onClick={onResetFilters}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              background: `var(--color-accent-primary, ${tokens.colors.accent.primary})20`,
              border: `1px solid var(--color-accent-primary, ${tokens.colors.accent.primary})40`,
              borderRadius: tokens.radius.md,
              color: `var(--color-accent-primary, ${tokens.colors.accent.primary})`,
              cursor: 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.bold,
            }}
          >
            {language === 'zh' ? '重置筛选' : 'Reset Filters'}
          </button>
        </Box>
      )}
    </>
  )
}
