'use client'

/**
 * Verified Trader Badge
 * Shows a verified checkmark badge next to trader names.
 */

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface VerifiedBadgeProps {
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
}

const SIZES = {
  sm: { icon: 12, fontSize: 11, padding: '1px 5px', gap: 3 },
  md: { icon: 14, fontSize: 12, padding: '2px 8px', gap: 4 },
  lg: { icon: 16, fontSize: 13, padding: '3px 10px', gap: 5 },
}

export default function VerifiedBadge({ size = 'sm', showLabel = true }: VerifiedBadgeProps) {
  const { t } = useLanguage()
  const s = SIZES[size]

  return (
    <span
      title={t('verifiedTooltip')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: s.gap,
        padding: s.padding,
        borderRadius: tokens.radius.md,
        fontSize: s.fontSize,
        fontWeight: 600,
        color: '#22d3ee',
        background: 'rgba(34, 211, 238, 0.12)',
        border: '1px solid rgba(34, 211, 238, 0.25)',
        lineHeight: 1.4,
        flexShrink: 0,
      }}
    >
      <svg width={s.icon} height={s.icon} viewBox="0 0 20 20" fill="currentColor">
        <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"/>
      </svg>
      {showLabel && t('verifiedBadge')}
    </span>
  )
}
