'use client'

/**
 * Registry-driven superset metric grid (spec §6 NULL-collapse).
 *
 * A cell renders iff the source capability lists the metric AND the value
 * is non-NULL — no dashes, the grid reflows. Driven entirely by
 * lib/constants/metric-registry.ts: adding an exchange adds capability
 * rows, never UI code.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  displayableMetrics,
  type MetricDef,
  type MetricTier,
} from '@/lib/constants/metric-registry'
import { formatMoney } from '@/lib/utils/money'
import { formatROI } from '@/lib/utils/format'
import type { ServingCurrency } from '@/lib/data/serving/types'
import InfoTooltip from '@/app/components/ui/InfoTooltip'

// Tier-grouped rendering (eToro-style sectioning): the registry `tier` field
// previously only sized the font, so 40+ co-populated metrics rendered as one
// flat wall. Group order + i18n'd section headers keep the grid legible.
const TIER_ORDER: readonly MetricTier[] = ['hero', 'standard', 'advanced']
const TIER_I18N: Record<MetricTier, string> = {
  hero: 'metricGroupPerformance',
  standard: 'metricGroupActivity',
  advanced: 'metricGroupAdvanced',
}

export interface MetricGridProps {
  stats: Record<string, number | string | null>
  capabilityMetrics: string[]
  currency: ServingCurrency
  /** Per-cell copy override for a proven source contract. Registry defaults
   * remain untouched so other sources and similarly named metrics stay safe. */
  metricLabelKeys?: Readonly<Record<string, string>>
  /** Optional accessible detail copy for the same explicitly proven cells. */
  metricTooltipKeys?: Readonly<Record<string, string>>
}

function formatValue(def: MetricDef, value: number | string, currency: ServingCurrency): string {
  if (typeof value === 'string') return value
  switch (def.format) {
    case 'pct':
      // ROI-semantic metrics reuse the shared Overview formatter so ingest-
      // clamped ±10000% values render '>10K%' instead of a fake '+10000.00%'.
      if (def.roiFormat) return formatROI(value)
      // Loss magnitudes stored positive (mdd) render as a loss, matching Overview.
      if (def.displaySign === 'negative') {
        return value === 0 ? '0.00%' : `-${Math.abs(value).toFixed(2)}%`
      }
      // Rates/magnitudes (win rate, volatility) where '+' would read as a delta.
      if (def.displaySign === 'none') return `${value.toFixed(2)}%`
      return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
    case 'money':
      return formatMoney({ value, currency }, { compact: true, signed: true })
    case 'ratio':
      return value.toFixed(2)
    case 'count':
      return Math.round(value).toLocaleString()
    case 'duration': {
      // Stored as hours (trader_stats.holding_duration_avg → epoch/3600)
      if (value >= 48) return `${(value / 24).toFixed(1)}d`
      if (value >= 1) return `${value.toFixed(1)}h`
      return `${Math.round(value * 60)}m`
    }
  }
}

function valueColor(def: MetricDef, value: number | string): string {
  if (typeof value !== 'number' || def.format === 'count' || def.format === 'duration') {
    return tokens.colors.text.primary
  }
  if (def.inverted) return tokens.colors.text.primary
  if (def.format === 'pct' || def.format === 'money') {
    if (value > 0) return 'var(--color-accent-success)'
    if (value < 0) return 'var(--color-accent-error)'
  }
  return tokens.colors.text.primary
}

function MetricCell({
  def,
  value,
  currency,
  labelKey,
  tooltipKey,
}: {
  def: MetricDef
  value: number | string
  currency: ServingCurrency
  labelKey?: string
  tooltipKey?: string
}) {
  const { t } = useLanguage()
  return (
    <Box
      style={{
        padding: tokens.spacing[3],
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.lg,
        border: '1px solid ' + tokens.colors.border.primary,
      }}
    >
      <Text
        size="xs"
        color="tertiary"
        style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 4 }}
      >
        {t(labelKey ?? def.i18nKey)}
        {tooltipKey && <InfoTooltip text={t(tooltipKey)} size={11} />}
      </Text>
      <Text
        size={def.tier === 'hero' ? 'lg' : 'md'}
        weight="bold"
        style={{ color: valueColor(def, value), fontVariantNumeric: 'tabular-nums' }}
      >
        {formatValue(def, value, currency)}
      </Text>
    </Box>
  )
}

export default function MetricGrid({
  stats,
  capabilityMetrics,
  currency,
  metricLabelKeys,
  metricTooltipKeys,
}: MetricGridProps) {
  const { t } = useLanguage()
  const defs = displayableMetrics(capabilityMetrics, stats)
  if (defs.length === 0) return null

  // Group by tier, dropping cells whose value NULL-collapsed after promotion.
  const groups = TIER_ORDER.map((tier) => ({
    tier,
    defs: defs.filter((d) => {
      const v = stats[d.key]
      return d.tier === tier && v !== null && v !== undefined
    }),
  })).filter((g) => g.defs.length > 0)
  if (groups.length === 0) return null
  // Headers only when ≥2 groups have content — a sparse-source grid stays chrome-free.
  const showHeaders = groups.length > 1

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
      {groups.map((group) => (
        <Box key={group.tier}>
          {showHeaders && (
            <Text
              size="xs"
              color="tertiary"
              weight="bold"
              style={{
                display: 'block',
                marginBottom: tokens.spacing[2],
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {t(TIER_I18N[group.tier])}
            </Text>
          )}
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
              gap: tokens.spacing[3],
            }}
          >
            {group.defs.map((def) => (
              <MetricCell
                key={def.key}
                def={def}
                value={stats[def.key]!}
                currency={currency}
                labelKey={metricLabelKeys?.[def.key]}
                tooltipKey={metricTooltipKeys?.[def.key]}
              />
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
