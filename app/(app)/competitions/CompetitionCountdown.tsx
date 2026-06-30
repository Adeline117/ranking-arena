'use client'

/**
 * CompetitionCountdown — live, second-by-second countdown.
 *
 * Runtime React component, so it MAY use `new Date()` / Date.now() in an effect
 * (the no-Date.now rule is for workflow SCRIPTS, not app code). Degrades to a
 * static placeholder on the server / first paint to avoid a hydration mismatch,
 * then ticks every second once mounted.
 *
 *  - status 'upcoming' → counts down to start_at, prefix "Starts in"
 *  - status 'active'   → counts down to end_at,   prefix "Ends in"
 *  - status 'completed' OR target passed → "Ended"
 */

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface CountdownProps {
  startAt: string
  endAt: string
  status: string
  /** Visual emphasis: 'sm' for cards, 'md' for the detail header. */
  size?: 'sm' | 'md'
  align?: 'left' | 'right'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

export default function CompetitionCountdown({
  startAt,
  endAt,
  status,
  size = 'sm',
  align = 'left',
}: CountdownProps) {
  const { t } = useLanguage()
  // null until mounted → SSR & first client paint render the same placeholder.
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const isUpcoming = status === 'upcoming'
  const target = new Date(isUpcoming ? startAt : endAt).getTime()
  const ended = status === 'completed' || (now != null && target - now <= 0)

  const prefix = ended ? t('compEnded') : isUpcoming ? t('compStartsIn') : t('compEndsIn')

  // First paint (now == null): show only the neutral prefix, no ticking numbers.
  const valueText = ended ? '' : now == null ? '—' : formatRemaining(target - now)

  const valueSize = size === 'md' ? tokens.typography.fontSize.lg : tokens.typography.fontSize.sm

  return (
    <span
      role="timer"
      aria-live="off"
      aria-label={`${prefix}${valueText ? ` ${valueText}` : ''}`}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: align === 'right' ? 'flex-end' : 'flex-start',
        gap: tokens.spacing[0.5],
      }}
    >
      <span
        style={{
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.tertiary,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {prefix}
      </span>
      {valueText && (
        <span
          style={{
            fontSize: valueSize,
            fontWeight: tokens.typography.fontWeight.semibold,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.02em',
            color: ended ? tokens.colors.text.tertiary : tokens.colors.text.primary,
          }}
        >
          {valueText}
        </span>
      )}
    </span>
  )
}
