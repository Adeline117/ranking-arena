'use client'

/**
 * CompetitionCapacityBar — entrants / max-participants progress bar.
 *
 * Colorblind-safe: the fill width itself encodes capacity (not color alone),
 * and a textual "n / max" + "Full" label carry the same signal. Color only
 * shifts to a warning accent when (near-)full as redundant reinforcement.
 */

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface CapacityBarProps {
  current: number
  max: number
  /** Show the "n / max" caption above the bar. */
  showLabel?: boolean
}

export default function CompetitionCapacityBar({
  current,
  max,
  showLabel = true,
}: CapacityBarProps) {
  const { t } = useLanguage()
  const safeMax = max > 0 ? max : 0
  const pct = safeMax > 0 ? Math.min(100, Math.round((current / safeMax) * 100)) : 0
  const isFull = safeMax > 0 && current >= safeMax
  const fillColor = isFull ? tokens.colors.accent.warning : tokens.colors.accent.primary

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1], minWidth: 120 }}
    >
      {showLabel && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: tokens.spacing[2],
          }}
        >
          <span
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
            }}
          >
            {t('compParticipants')}
          </span>
          <span
            style={{
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.medium,
              fontVariantNumeric: 'tabular-nums',
              color: isFull ? tokens.colors.accent.warning : tokens.colors.text.secondary,
            }}
          >
            {current}/{safeMax}
            {isFull ? ` · ${t('compCapacityFull')}` : ''}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={current}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-label={t('compParticipants')}
        style={{
          width: '100%',
          height: 6,
          borderRadius: tokens.radius.full,
          background: tokens.colors.bg.tertiary,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: tokens.radius.full,
            background: fillColor,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  )
}
