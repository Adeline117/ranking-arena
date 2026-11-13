'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

/**
 * Small "All-time" chip for a 90D figure that is really lifetime data
 * (e.g. Hyperliquid). Tooltip explains why.
 */
export function AllTime90dBadge() {
  const { t } = useLanguage()
  const tooltip = t('allTime90dTooltip')
  return (
    <span
      data-testid="alltime-90d-badge"
      title={tooltip}
      aria-label={tooltip}
      style={{
        display: 'inline-block',
        padding: `0 ${tokens.spacing[1]}`,
        borderRadius: tokens.radius.sm,
        border: '1px solid var(--color-border-primary)',
        color: tokens.colors.text.tertiary,
        fontSize: tokens.typography.fontSize.xs,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        cursor: 'help',
      }}
    >
      {t('allTime90dShort')}
    </span>
  )
}
