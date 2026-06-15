'use client'

/**
 * Trader metadata strip (ARENA_REBUILD_SPEC §2.5 — copy-trade / activity meta).
 *
 * A row of compact "label · value" chips for scalar context the adapters
 * ALREADY capture into trader_stats.extras but nothing surfaced: last-trade
 * recency, days trading / leading, the copier cap, and margin/equity. Each
 * field resolves from an ordered alias list (sources name the same fact
 * differently) and NULL-collapses — the chip is omitted when absent and the
 * whole strip returns null when nothing resolves. No new fetching.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { formatMoney } from '@/lib/utils/money'
import type { ServingCurrency } from '@/lib/data/serving/types'

type MetaKind = 'timeago' | 'days' | 'count' | 'money'

interface MetaField {
  i18nKey: string
  kind: MetaKind
  /** extras keys to try in order — first valid value wins. */
  aliases: readonly string[]
}

const META_FIELDS: readonly MetaField[] = [
  {
    i18nKey: 'metaLastTrade',
    kind: 'timeago',
    aliases: ['last_trade_time', 'last_trade_at', 'last_traded_at', 'last_order_time'],
  },
  {
    i18nKey: 'metaTradingDays',
    kind: 'days',
    aliases: ['trading_days', 'trade_days', 'days_trading', 'trade_count_lifetime'],
  },
  { i18nKey: 'metaLeadingDays', kind: 'days', aliases: ['leading_days', 'lead_days'] },
  {
    i18nKey: 'metaCopierCap',
    kind: 'count',
    aliases: ['copier_count_max', 'max_copier_slots', 'copier_limit'],
  },
  {
    i18nKey: 'metaMarginBalance',
    kind: 'money',
    aliases: ['margin_balance', 'wallet_balance', 'total_equity', 'total_balance'],
  },
]

function resolveAlias(extras: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const a of aliases) {
    const v = extras[a]
    if (v !== null && v !== undefined && v !== '') return v
  }
  return undefined
}

export interface TraderMetaStripProps {
  extras: Record<string, unknown>
  currency: ServingCurrency
}

export default function TraderMetaStrip({ extras, currency }: TraderMetaStripProps) {
  const { t, language } = useLanguage()

  const chips: Array<{ key: string; label: string; value: string }> = []
  for (const field of META_FIELDS) {
    const raw = resolveAlias(extras, field.aliases)
    if (raw === undefined) continue

    let value: string | null = null
    if (field.kind === 'timeago') {
      const iso = typeof raw === 'string' ? raw : null
      if (iso && !Number.isNaN(Date.parse(iso))) value = formatTimeAgo(iso, language)
    } else if (field.kind === 'money') {
      const n = typeof raw === 'string' ? Number(raw) : raw
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
        value = formatMoney({ value: n, currency }, { compact: true })
      }
    } else {
      // days / count — non-negative integer
      const n = typeof raw === 'string' ? Number(raw) : raw
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
        value = Math.round(n).toLocaleString()
      }
    }
    if (value !== null) chips.push({ key: field.i18nKey, label: t(field.i18nKey), value })
  }

  if (chips.length === 0) return null

  return (
    <Box
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacing[4],
        rowGap: tokens.spacing[2],
        alignItems: 'baseline',
      }}
    >
      {chips.map((chip) => (
        <Box key={chip.key} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
          <Text size="xs" color="tertiary">
            {chip.label}
          </Text>
          <Text
            size="sm"
            weight="semibold"
            color="primary"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {chip.value}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
