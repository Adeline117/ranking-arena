/**
 * ScoreMiniBar — token-styled arena-score mini-bar (audit §4).
 *
 * Shows arena_score / 100 as a thin progress bar, fill color graded by tier
 * via getScoreColorInfo — the single source of truth shared with the score
 * chips (so the bar, the chip and the circle never disagree on tier color).
 *
 * Pure / SSR-safe (no hooks, no 'use client') so it renders identically in the
 * server SSRRankingTable shell and the hydrated client rows/cards — no
 * SSR↔hydration colour shift.
 */
import React from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { getScoreColorInfo } from '@/lib/utils/score-colors'
import { normalizeFiniteScore } from './RankingTableTypes'
import { t } from '@/lib/i18n'

export interface ScoreMiniBarProps {
  /** Arena score (0–100). */
  score: number
  /** Track width in px. */
  width?: number
  /** Bar thickness in px. */
  height?: number
  /** Render the rounded numeric score before the bar. */
  showValue?: boolean
  className?: string
  style?: React.CSSProperties
  /**
   * Localized accessible label. Hook-free component, so client callers pass
   * it (e.g. t('arenaScoreOfHundredAria')); the default uses the same key via
   * the non-hook i18n lookup.
   */
  ariaLabel?: string
}

export default function ScoreMiniBar({
  score,
  width = 64,
  height = 6,
  showValue = false,
  className,
  style,
  ariaLabel,
}: ScoreMiniBarProps) {
  const finiteScore = normalizeFiniteScore(score)
  if (finiteScore == null) return null

  const rounded = Math.round(finiteScore)
  const pct = Math.max(0, Math.min(finiteScore, 100))
  const color = getScoreColorInfo(finiteScore).color

  return (
    <div
      className={className}
      style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], ...style }}
    >
      {showValue && (
        <span
          style={{
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.semibold,
            color: 'var(--color-text-primary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {rounded}
        </span>
      )}
      <div
        role="img"
        aria-label={ariaLabel ?? t('arenaScoreOfHundredAria').replace('{score}', String(rounded))}
        style={{
          width,
          height,
          borderRadius: tokens.radius.full,
          background: alpha(tokens.colors.text.tertiary, 14),
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: tokens.radius.full,
            background: color,
          }}
        />
      </div>
    </div>
  )
}
