'use client'

import { tokens, alpha } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/**
 * Trust-facing anti-gaming ⚠️ badge — renders one warning chip per flag code
 * from lib/scoring/anti-gaming.ts. Reused across ranking cards, the desktop
 * table cell, and the profile header so the signal is consistent everywhere.
 * Honest, non-accusatory framing: "statistically implausible — interpret with
 * caution", never "cheater". Warning-themed (shifts with light/dark theme).
 */

const FLAG_LABEL_KEY: Record<string, string> = {
  implausible_win_rate: 'antiGamingWinRateLabel',
}
const FLAG_TIP_KEY: Record<string, string> = {
  implausible_win_rate: 'antiGamingWinRateTip',
}

interface AntiGamingBadgeProps {
  flags?: string[] | null
  /** For interpolating the tooltip copy. */
  winRate?: number | null
  tradesCount?: number | null
  /** Icon-only (dense table cells) — hides the text label. */
  compact?: boolean
}

export default function AntiGamingBadge({
  flags,
  winRate,
  tradesCount,
  compact,
}: AntiGamingBadgeProps) {
  const { t } = useLanguage()
  if (!flags || flags.length === 0) return null

  return (
    <>
      {flags.map((code) => {
        const labelKey = FLAG_LABEL_KEY[code]
        const tipKey = FLAG_TIP_KEY[code]
        if (!labelKey || !tipKey) return null
        const tip = t(tipKey)
          .replace('{winRate}', winRate != null ? String(Math.round(winRate)) : '?')
          .replace('{trades}', tradesCount != null ? String(tradesCount) : '?')
        return (
          <span
            key={code}
            role="img"
            aria-label={tip}
            title={tip}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: compact ? '1px 4px' : '2px 7px',
              borderRadius: tokens.radius.sm,
              background: alpha(tokens.colors.accent.warning, 8),
              border: `1px solid ${alpha(tokens.colors.accent.warning, 21)}`,
              color: tokens.colors.accent.warning,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: Number(tokens.typography.fontWeight.bold),
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke={tokens.colors.accent.warning}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            {!compact && t(labelKey)}
          </span>
        )
      })}
    </>
  )
}
