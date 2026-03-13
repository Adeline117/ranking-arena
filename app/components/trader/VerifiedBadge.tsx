'use client'

/**
 * Verified Trader Badge
 * Shows a prominent verified badge next to trader names.
 * Upgraded design: gradient border, shield icon, more visual impact.
 */

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface VerifiedBadgeProps {
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
  /** Use 'prominent' for trader detail page header, 'subtle' for leaderboard rows */
  variant?: 'default' | 'prominent' | 'subtle'
}

const SIZES = {
  sm: { icon: 13, fontSize: 11, padding: '2px 6px', gap: 3 },
  md: { icon: 15, fontSize: 12, padding: '3px 10px', gap: 4 },
  lg: { icon: 18, fontSize: 14, padding: '4px 12px', gap: 5 },
}

/** Shield checkmark SVG path - more distinctive than a simple circle */
const SHIELD_CHECK_PATH = 'M10 1l6 3v4c0 4.5-2.5 8.5-6 10-3.5-1.5-6-5.5-6-10V4l6-3zm-1.5 11.5l5-5-1.4-1.4-3.6 3.6-1.6-1.6-1.4 1.4 3 3z'

export default function VerifiedBadge({
  size = 'sm',
  showLabel = true,
  variant = 'default',
}: VerifiedBadgeProps) {
  const { t } = useLanguage()
  const s = SIZES[size]

  // Variant-specific styles
  const variantStyles: Record<string, React.CSSProperties> = {
    default: {
      color: '#22d3ee',
      background: 'rgba(34, 211, 238, 0.12)',
      border: '1px solid rgba(34, 211, 238, 0.25)',
    },
    prominent: {
      color: '#fff',
      background: 'linear-gradient(135deg, rgba(34, 211, 238, 0.25), rgba(99, 102, 241, 0.25))',
      border: '1px solid rgba(34, 211, 238, 0.4)',
      boxShadow: '0 0 8px rgba(34, 211, 238, 0.15)',
    },
    subtle: {
      color: '#22d3ee',
      background: 'transparent',
      border: 'none',
      padding: '0',
    },
  }

  const vStyle = variantStyles[variant] || variantStyles.default

  return (
    <span
      title={t('verifiedTooltip')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: variant === 'subtle' ? 2 : s.gap,
        padding: variant === 'subtle' ? '0' : s.padding,
        borderRadius: tokens.radius.md,
        fontSize: s.fontSize,
        fontWeight: 600,
        lineHeight: 1.4,
        flexShrink: 0,
        ...vStyle,
      }}
    >
      <svg
        width={variant === 'subtle' ? s.icon - 1 : s.icon}
        height={variant === 'subtle' ? s.icon - 1 : s.icon}
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path d={variant === 'subtle'
          ? 'M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z'
          : SHIELD_CHECK_PATH
        }/>
      </svg>
      {showLabel && (variant === 'prominent' ? t('verifiedTraderLabel') : t('verifiedBadge'))}
    </span>
  )
}
