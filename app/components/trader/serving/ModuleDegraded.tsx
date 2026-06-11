'use client'

/**
 * Module-level degradation panel (spec §2.4): when a core module's
 * upstream fetch is pending/failed, the module says so locally — the rest
 * of the page stays rendered. NEVER escalate to a full-page error.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export interface ModuleDegradedProps {
  /** Show the retry button (polling window exhausted / fetch error). */
  onRetry?: () => void
  style?: React.CSSProperties
}

export default function ModuleDegraded({ onRetry, style }: ModuleDegradedProps) {
  const { t } = useLanguage()
  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacing[3],
        padding: tokens.spacing[6],
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.lg,
        border: '1px dashed ' + tokens.colors.border.primary,
        ...style,
      }}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-text-tertiary)"
        strokeWidth="2"
        aria-hidden
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
      <Text size="sm" color="tertiary" style={{ textAlign: 'center' }}>
        {t('moduleDataPending')}
      </Text>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.md,
            border: '1px solid ' + tokens.colors.border.primary,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {t('moduleRetry')}
        </button>
      )}
    </Box>
  )
}
