'use client'

/**
 * Derived-leaderboard label (spec §6, REQUIRED): MEXC/BTCC synthesized
 * 30/90 boards only contain traders who appeared on the native board, so
 * they are NOT the exchange's full ranking — say so inline, always.
 */

import { tokens } from '@/lib/design-tokens'
import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function DerivedBoardBadge() {
  const { t } = useLanguage()
  return (
    <span
      title={t('derivedBoardTooltip')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: tokens.spacing[1],
        padding: '2px 6px',
        background: 'color-mix(in srgb, var(--color-text-tertiary) 8%, transparent)',
        borderRadius: tokens.radius.md,
        cursor: 'help',
      }}
    >
      <svg
        width="11"
        height="11"
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
      <Text size="xs" style={{ color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
        {t('derivedBoardBadge')}
      </Text>
    </span>
  )
}
