'use client'

/**
 * Copy-trading commercials card (M2-2a, eToro "Copiers Card" pattern).
 *
 * The "should I copy this trader?" decision zone: current/cumulative copiers,
 * 30d copier growth, copiers' total earnings, lead principal, follower margin
 * under management, min copy amount, profit share and tenure. These are
 * COMMERCIAL facts, not performance metrics — mixing them into the flat
 * MetricGrid is what turns the grid into a number wall (UIUX audit), so they
 * get their own titled card on the Overview tab instead.
 *
 * Every field resolves from an ordered extras-alias list (sources spell the
 * same fact differently) and NULL-collapses; the whole card returns null when
 * nothing resolves. No new fetching — reads the same 90d extras the meta strip
 * uses.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatMoney } from '@/lib/utils/money'
import type { ServingCurrency } from '@/lib/data/serving/types'

type FieldKind = 'count' | 'money' | 'signedMoney' | 'signedCount' | 'pct' | 'days'

interface CardField {
  i18nKey: string
  kind: FieldKind
  aliases: readonly string[]
  /** Optional cap aliases — renders "value / cap" (current copiers vs slots). */
  capAliases?: readonly string[]
}

const CARD_FIELDS: readonly CardField[] = [
  {
    i18nKey: 'copyCardCurrentCopiers',
    kind: 'count',
    aliases: ['copier_count_current', 'current_followers', 'cur_follower_num'],
    capAliases: ['copier_count_max', 'max_copier_slots', 'copier_limit'],
  },
  {
    i18nKey: 'copyCardCumulativeCopiers',
    kind: 'count',
    aliases: [
      'copier_count_history',
      'copier_count_total',
      'total_copiers_history',
      'cum_follower_count',
    ],
  },
  {
    i18nKey: 'copyCardGrowth30d',
    kind: 'signedCount',
    aliases: ['copier_growth_30d', 'copier_growth'],
  },
  {
    i18nKey: 'copyCardCopierEarnings',
    kind: 'signedMoney',
    aliases: ['copier_total_profit', 'copier_earnings', 'followers_earnings', 'follower_pnl'],
  },
  { i18nKey: 'copyCardPrincipal', kind: 'money', aliases: ['principal', 'lead_principal'] },
  {
    i18nKey: 'copyCardFollowerMargin',
    kind: 'money',
    aliases: ['follower_margin', 'following_amount'],
  },
  { i18nKey: 'copyCardMinCopy', kind: 'money', aliases: ['min_copy_amount'] },
  { i18nKey: 'copyCardProfitShare', kind: 'pct', aliases: ['profit_share_rate'] },
  { i18nKey: 'copyCardTenure', kind: 'days', aliases: ['trader_tenure_days'] },
]

function firstFinite(extras: Record<string, unknown>, aliases: readonly string[]): number | null {
  for (const a of aliases) {
    const raw = extras[a]
    const n = typeof raw === 'string' ? Number(raw) : raw
    if (typeof n === 'number' && Number.isFinite(n)) return n
  }
  return null
}

export interface CopyTradingCardProps {
  extras: Record<string, unknown>
  currency: ServingCurrency
}

export default function CopyTradingCard({ extras, currency }: CopyTradingCardProps) {
  const { t } = useLanguage()

  const chips: Array<{ key: string; label: string; value: string; tone?: 'up' | 'down' }> = []
  for (const field of CARD_FIELDS) {
    const n = firstFinite(extras, field.aliases)
    if (n === null) continue

    let value: string | null = null
    let tone: 'up' | 'down' | undefined
    switch (field.kind) {
      case 'count': {
        if (n < 0) break
        const cap = field.capAliases ? firstFinite(extras, field.capAliases) : null
        value =
          cap !== null && cap > 0
            ? `${Math.round(n).toLocaleString()} / ${Math.round(cap).toLocaleString()}`
            : Math.round(n).toLocaleString()
        break
      }
      case 'signedCount':
        value = `${n > 0 ? '+' : ''}${Math.round(n).toLocaleString()}`
        if (n !== 0) tone = n > 0 ? 'up' : 'down'
        break
      case 'money':
        if (n <= 0) break
        value = formatMoney({ value: n, currency }, { compact: true })
        break
      case 'signedMoney':
        value = formatMoney({ value: n, currency }, { compact: true, signed: true })
        if (n !== 0) tone = n > 0 ? 'up' : 'down'
        break
      case 'pct':
        if (n < 0) break
        value = `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`
        break
      case 'days':
        if (n < 0) break
        value = `${Math.round(n).toLocaleString()}D`
        break
    }
    if (value !== null) chips.push({ key: field.i18nKey, label: t(field.i18nKey), value, tone })
  }

  if (chips.length === 0) return null

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: '1px solid ' + tokens.colors.border.primary,
      }}
    >
      <Text
        size="xs"
        color="tertiary"
        weight="bold"
        style={{
          display: 'block',
          marginBottom: tokens.spacing[3],
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {t('copyCardTitle')}
      </Text>
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: tokens.spacing[3],
        }}
      >
        {chips.map((chip) => (
          <Box key={chip.key}>
            <Text size="xs" color="tertiary" style={{ display: 'block', marginBottom: 2 }}>
              {chip.label}
            </Text>
            <Text
              size="sm"
              weight="semibold"
              style={{
                fontVariantNumeric: 'tabular-nums',
                color:
                  chip.tone === 'up'
                    ? 'var(--color-accent-success)'
                    : chip.tone === 'down'
                      ? 'var(--color-accent-error)'
                      : tokens.colors.text.primary,
              }}
            >
              {chip.value}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
