'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'

type ViewMode = 'current' | 'history'

interface PortfolioTableHeaderProps {
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
}

export default function PortfolioTableHeader({ viewMode, onViewModeChange }: PortfolioTableHeaderProps) {
  const { t } = useLanguage()

  return (
    <Box
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: tokens.spacing[5],
        borderBottom: `1px solid ${tokens.colors.border.primary}40`,
        background: `linear-gradient(180deg, ${tokens.colors.bg.secondary} 0%, transparent 100%)`,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          {t('portfolio')}
        </Text>
      </Box>

      {/* View Mode Toggle */}
      <Box
        style={{
          display: 'flex',
          gap: 2,
          background: tokens.colors.bg.tertiary,
          padding: 3,
          borderRadius: tokens.radius.lg,
        }}
      >
        <button
          onClick={() => onViewModeChange('current')}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.md,
            border: 'none',
            background: viewMode === 'current'
              ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
              : 'transparent',
            color: viewMode === 'current' ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: viewMode === 'current' ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
            cursor: 'pointer',
            transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[1],
          }}
        >
          {t('current')}
        </button>
        <button
          onClick={() => onViewModeChange('history')}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.md,
            border: 'none',
            background: viewMode === 'history'
              ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
              : 'transparent',
            color: viewMode === 'history' ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: viewMode === 'history' ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
            cursor: 'pointer',
            transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[1],
          }}
        >
          {t('positionHistory')}
        </button>
      </Box>
    </Box>
  )
}
