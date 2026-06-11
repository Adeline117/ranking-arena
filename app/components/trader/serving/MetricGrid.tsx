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
import { displayableMetrics, type MetricDef } from '@/lib/constants/metric-registry'
import { formatMoney } from '@/lib/utils/money'
import type { ServingCurrency } from '@/lib/data/serving/types'

export interface MetricGridProps {
  stats: Record<string, number | string | null>
  capabilityMetrics: string[]
  currency: ServingCurrency
}

function formatValue(def: MetricDef, value: number | string, currency: ServingCurrency): string {
  if (typeof value === 'string') return value
  switch (def.format) {
    case 'pct':
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
    if (value > 0) return 'var(--color-success, #22c55e)'
    if (value < 0) return 'var(--color-danger, #ef4444)'
  }
  return tokens.colors.text.primary
}

export default function MetricGrid({ stats, capabilityMetrics, currency }: MetricGridProps) {
  const { t } = useLanguage()
  const defs = displayableMetrics(capabilityMetrics, stats)
  if (defs.length === 0) return null

  return (
    <Box
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: tokens.spacing[3],
      }}
    >
      {defs.map((def) => {
        const value = stats[def.key]
        if (value === null || value === undefined) return null
        return (
          <Box
            key={def.key}
            style={{
              padding: tokens.spacing[3],
              background: tokens.colors.bg.tertiary,
              borderRadius: tokens.radius.lg,
              border: '1px solid ' + tokens.colors.border.primary,
            }}
          >
            <Text size="xs" color="tertiary" style={{ display: 'block', marginBottom: 4 }}>
              {t(def.i18nKey)}
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
      })}
    </Box>
  )
}
