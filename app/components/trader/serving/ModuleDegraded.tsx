'use client'

/**
 * Module-level degradation panel (spec §2.4): when a core module is
 * unavailable after a failed or bounded upstream attempt, it says so locally
 * while the rest of the page stays rendered. In-flight work uses a separate
 * skeleton state; NEVER escalate either condition to a full-page error.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export interface ModuleDegradedProps {
  /** Show the retry button (polling window exhausted / fetch error). */
  onRetry?: () => void
  style?: React.CSSProperties
}

export interface ModuleRefreshFailureNoticeProps {
  /** Exact copy for the data family whose last successful value remains visible. */
  messageKey?: string
  isRetrying?: boolean
  onRetry: () => void
}

export default function ModuleDegraded({ onRetry, style }: ModuleDegradedProps) {
  const { t } = useLanguage()
  return (
    <Box
      role="status"
      aria-live="polite"
      aria-atomic="true"
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
        {t('moduleDataUnavailable')}
      </Text>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            minHeight: tokens.touchTarget.min,
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.md,
            border: '1px solid ' + tokens.colors.border.primary,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            cursor: 'pointer',
          }}
        >
          {t('moduleRetry')}
        </button>
      )}
    </Box>
  )
}

/**
 * Keep previously loaded values visible only with an explicit stale-data
 * disclosure. This is intentionally smaller than ModuleDegraded: it applies
 * when a module still has truthful historical content but its refresh failed.
 */
export function ModuleRefreshFailureNotice({
  messageKey = 'moduleRefreshFailed',
  isRetrying = false,
  onRetry,
}: ModuleRefreshFailureNoticeProps) {
  const { t } = useLanguage()
  return (
    <Box
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacing[2],
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.tertiary,
      }}
    >
      <Text size="sm" style={{ color: tokens.colors.accent.warning }}>
        {t(messageKey)}
      </Text>
      <button
        type="button"
        onClick={onRetry}
        disabled={isRetrying}
        style={{
          minHeight: tokens.touchTarget.min,
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.md,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.sm,
          cursor: isRetrying ? 'wait' : 'pointer',
          opacity: isRetrying ? 0.6 : 1,
        }}
      >
        {isRetrying ? t('loading') : t('moduleRetry')}
      </button>
    </Box>
  )
}
