'use client'

/**
 * 独家信号 chips (spec §12.2/§12.3): exchange-exclusive qualitative signals
 * rendered above the metric grid, extracted from trader_stats.extras via the
 * Arena Score v2 feature layer so the UI and future scoring read ONE shape.
 *
 *   - style label chips (Bitget/Gate/HTX/MEXC/XT style_labels & style_tags)
 *   - risk rating badge 1-10 (BingX), color-banded
 *   - last-liquidation chip (Gate — the risk signal no other exchange shows)
 *
 * Capability-driven NULL-collapse: a chip renders iff its feature is
 * non-NULL; with zero features the whole row collapses (returns null).
 */

import { useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { extractFeatureVector } from '@/lib/scoring/arena-score-v2-features'

export interface SignalChipsProps {
  source: string
  extras: Record<string, unknown>
}

const CHIP_BASE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: `2px ${tokens.spacing[2]}`,
  borderRadius: tokens.radius.full,
  fontSize: tokens.typography.fontSize.xs,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  border: '1px solid var(--color-border-primary)',
  background: 'var(--color-bg-tertiary)',
  color: 'var(--color-text-secondary)',
}

function riskBandColor(rating: number): { fg: string; bg: string } {
  if (rating <= 3)
    return {
      fg: 'var(--color-accent-success)',
      bg: 'color-mix(in srgb, var(--color-accent-success) 12%, transparent)',
    }
  if (rating <= 6) return { fg: 'var(--color-warning, #f59e0b)', bg: 'rgba(245,158,11,0.12)' }
  return {
    fg: 'var(--color-accent-error)',
    bg: 'color-mix(in srgb, var(--color-accent-error) 12%, transparent)',
  }
}

export default function SignalChips({ source, extras }: SignalChipsProps) {
  const { t, language } = useLanguage()
  const fv = useMemo(() => extractFeatureVector({ source, extras }), [source, extras])

  const hasAny =
    fv.style_labels.length > 0 || fv.risk_rating !== null || fv.last_liquidation_at !== null
  if (!hasAny) return null

  return (
    <div
      role="list"
      aria-label={t('signalStyleLabels')}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: tokens.spacing[2],
      }}
    >
      {fv.risk_rating !== null && (
        <span
          role="listitem"
          title={t('signalRiskRating')}
          style={{
            ...CHIP_BASE,
            color: riskBandColor(fv.risk_rating).fg,
            background: riskBandColor(fv.risk_rating).bg,
            borderColor: 'transparent',
            fontWeight: 700,
          }}
        >
          {t('signalRiskRating')} {fv.risk_rating}/10
        </span>
      )}

      {fv.last_liquidation_at !== null && (
        <span
          role="listitem"
          style={{
            ...CHIP_BASE,
            color: 'var(--color-accent-error)',
            background: 'rgba(239,68,68,0.10)',
            borderColor: 'transparent',
            fontWeight: 600,
          }}
        >
          {t('signalLastLiquidation')}{' '}
          <time
            dateTime={fv.last_liquidation_at}
            title={new Date(fv.last_liquidation_at).toLocaleString()}
          >
            {formatTimeAgo(fv.last_liquidation_at, language)}
          </time>
        </span>
      )}

      {fv.style_labels.map((label) => (
        <span key={label} role="listitem" style={CHIP_BASE}>
          {label}
        </span>
      ))}

      {fv.style_labels.length > 0 && (
        <Text size="xs" color="tertiary" style={{ opacity: 0.6 }}>
          {t('signalLabelsFromExchange')}
        </Text>
      )}
    </div>
  )
}
