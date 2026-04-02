'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '../base'

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
  language: _language,
  selectedExchange,
  advancedFilteredCount,
  tradersCount,
  hasActiveFilters,
  onResetFilters,
}: FilterStatusMessagesProps) {
  const { t } = useLanguage()
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
          {t('tradersOnExchange').replace('{count}', String(advancedFilteredCount))}
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
            {t('allTradersFilteredOut')}
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
            {t('resetFilters')}
          </button>
        </Box>
      )}
    </>
  )
}
