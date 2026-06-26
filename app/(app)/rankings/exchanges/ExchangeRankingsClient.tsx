'use client'

/**
 * Exchange Rankings client island (spec §6.1): timeframe switch + table.
 * All three timeframes arrive pre-fetched from the server component (ISR),
 * so switching is instant and the island never fetches.
 */

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import PageHeader from '@/app/components/ui/PageHeader'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { getExchangeLogoUrl } from '@/lib/utils/avatar'
import DerivedBoardBadge from '@/app/components/common/DerivedBoardBadge'
import ProvenanceFooter from '@/app/components/common/ProvenanceFooter'
import type {
  ExchangeRankings,
  ExchangeRankingsTimeframe,
} from '@/lib/data/serving/exchange-rankings'

const TIMEFRAMES: ExchangeRankingsTimeframe[] = [7, 30, 90]

const PRODUCT_I18N = {
  spot: 'exchangeRankingsProductSpot',
  futures: 'exchangeRankingsProductFutures',
  cfd: 'exchangeRankingsProductCfd',
  onchain: 'exchangeRankingsProductOnchain',
} as const

function fmtPct(v: number | null, signed = false): string {
  if (v === null) return '—'
  const sign = signed && v > 0 ? '+' : ''
  return `${sign}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
}

function roiColor(v: number | null): string | undefined {
  if (v === null) return undefined
  return v >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
}

function fmtMoney(value: number, currency: string): string {
  const sign = value > 0 ? '+' : ''
  const compact = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
  return `${sign}${compact} ${currency}`
}

const TH_STYLE: React.CSSProperties = {
  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
  fontSize: tokens.typography.fontSize.xs,
  fontWeight: 600,
  color: 'var(--color-text-tertiary)',
  textAlign: 'right',
  whiteSpace: 'nowrap',
}

const TD_STYLE: React.CSSProperties = {
  padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
  fontSize: tokens.typography.fontSize.sm,
  textAlign: 'right',
  whiteSpace: 'nowrap',
  borderTop: '1px solid var(--color-border-primary)',
}

export interface ExchangeRankingsClientProps {
  byTimeframe: Record<ExchangeRankingsTimeframe, ExchangeRankings | null>
}

export default function ExchangeRankingsClient({ byTimeframe }: ExchangeRankingsClientProps) {
  const { t, language } = useLanguage()
  const [tf, setTf] = useState<ExchangeRankingsTimeframe>(90)

  const data = byTimeframe[tf]
  const rows = data?.rows ?? []
  const newestAsOf = rows.reduce<string | null>(
    (acc, r) => (acc === null || r.provenance.asOf > acc ? r.provenance.asOf : acc),
    null
  )

  return (
    <Box>
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[4],
        }}
      >
        <PageHeader
          title={t('exchangeRankingsTitle')}
          subtitle={t('exchangeRankingsSubtitle')}
          style={{ marginBottom: 0 }}
        />

        <Box style={{ display: 'flex', gap: tokens.spacing[1] }} role="tablist">
          {TIMEFRAMES.map((option) => (
            <button
              key={option}
              role="tab"
              aria-selected={tf === option}
              onClick={() => setTf(option)}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tf === option ? 700 : 500,
                color: tf === option ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                background: tf === option ? 'var(--color-bg-tertiary)' : 'transparent',
                border: '1px solid var(--color-border-primary)',
                borderRadius: tokens.radius.md,
                cursor: 'pointer',
              }}
            >
              {option}D
            </button>
          ))}
        </Box>
      </Box>

      {rows.length === 0 ? (
        <Box
          style={{
            padding: tokens.spacing[8],
            textAlign: 'center',
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.lg,
          }}
        >
          <Text size="sm" color="tertiary">
            {t('exchangeRankingsEmpty')}
          </Text>
        </Box>
      ) : (
        <Box
          style={{
            overflowX: 'auto',
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.lg,
            background: 'var(--color-bg-secondary)',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH_STYLE, textAlign: 'left' }}>
                  {t('exchangeRankingsColExchange')}
                </th>
                <th style={TH_STYLE}>{t('exchangeRankingsColTraders')}</th>
                <th style={TH_STYLE}>{t('exchangeRankingsColMedianRoi')}</th>
                <th style={TH_STYLE}>{t('exchangeRankingsColTopDecileRoi')}</th>
                <th style={TH_STYLE}>{t('exchangeRankingsColProfitable')}</th>
                <th style={TH_STYLE}>{t('exchangeRankingsColCopierPnl')}</th>
                <th style={TH_STYLE}>{t('exchangeRankingsColBotShare')}</th>
                <th style={TH_STYLE}>{t('exchangeRankingsColAsOf')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.source}>
                  <td style={{ ...TD_STYLE, textAlign: 'left' }}>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                      {}
                      <img
                        src={getExchangeLogoUrl(row.source)}
                        alt={row.exchangeName}
                        width={20}
                        height={20}
                        style={{ borderRadius: tokens.radius.sm, flexShrink: 0 }}
                      />
                      <Text size="sm" weight="bold">
                        {row.exchangeName}
                      </Text>
                      <Text size="xs" color="tertiary">
                        {t(PRODUCT_I18N[row.productType])}
                      </Text>
                      {row.provenance.derived && <DerivedBoardBadge />}
                    </Box>
                  </td>
                  <td style={TD_STYLE}>{row.rankedTraders.toLocaleString()}</td>
                  <td style={{ ...TD_STYLE, color: roiColor(row.medianRoi) }}>
                    {fmtPct(row.medianRoi, true)}
                  </td>
                  <td style={{ ...TD_STYLE, color: roiColor(row.topDecileRoi) }}>
                    {fmtPct(row.topDecileRoi, true)}
                  </td>
                  <td style={TD_STYLE}>{fmtPct(row.pctProfitable)}</td>
                  <td
                    style={{
                      ...TD_STYLE,
                      color: row.copierPnl ? roiColor(row.copierPnl.value) : undefined,
                    }}
                  >
                    {row.copierPnl ? fmtMoney(row.copierPnl.value, row.copierPnl.currency) : '—'}
                  </td>
                  <td style={TD_STYLE}>{fmtPct(row.botShare)}</td>
                  <td style={{ ...TD_STYLE, color: 'var(--color-text-tertiary)' }}>
                    <time
                      dateTime={row.provenance.asOf}
                      title={new Date(row.provenance.asOf).toLocaleString()}
                    >
                      {formatTimeAgo(row.provenance.asOf, language)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      )}

      <Text
        size="xs"
        color="tertiary"
        style={{ display: 'block', marginTop: tokens.spacing[3], opacity: 0.8 }}
      >
        {t('exchangeRankingsNote')}
      </Text>
      {newestAsOf && (
        <ProvenanceFooter provenance={{ source: 'arena', asOf: newestAsOf }} exchangeName="Arena" />
      )}
    </Box>
  )
}
