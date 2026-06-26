'use client'

/**
 * Weekly Cross-Exchange ROI Arena client island (spec §12.6): pooled 7d-ROI
 * podium + table across serving sources, with BitMart's official weekly
 * arena as a reference panel. Data arrives pre-fetched from the server
 * component (ISR 1800) — the island never fetches.
 */

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import PageHeader from '@/app/components/ui/PageHeader'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { getExchangeLogoUrl } from '@/lib/utils/avatar'
import DerivedBoardBadge from '@/app/components/common/DerivedBoardBadge'
import ProvenanceFooter from '@/app/components/common/ProvenanceFooter'
import type { BitmartWeeklyCategoryKey, WeeklyLeaders } from '@/lib/data/serving/weekly-leaders'

const CATEGORY_I18N: Record<BitmartWeeklyCategoryKey, string> = {
  open: 'weeklyArenaCategoryOpen',
  low_lev: 'weeklyArenaCategoryLowLev',
  protected: 'weeklyArenaCategoryProtected',
}

function fmtRoi(v: number): string {
  const compactOver = 10_000
  const sign = v > 0 ? '+' : ''
  if (Math.abs(v) >= compactOver) {
    return `${sign}${new Intl.NumberFormat('en', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(v)}%`
  }
  return `${sign}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
}

function roiColor(v: number): string {
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

export interface WeeklyArenaClientProps {
  data: WeeklyLeaders
}

export default function WeeklyArenaClient({ data }: WeeklyArenaClientProps) {
  const { t, language } = useLanguage()
  const { rows, bitmart } = data

  const newestAsOf = rows.reduce<string | null>(
    (acc, r) => (acc === null || r.provenance.asOf > acc ? r.provenance.asOf : acc),
    null
  )

  return (
    <Box>
      <PageHeader title={t('weeklyArenaTitle')} subtitle={t('weeklyArenaSubtitle')} compact />

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
            {t('weeklyArenaEmpty')}
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
                <th style={{ ...TH_STYLE, textAlign: 'left' }}>{t('weeklyArenaColRank')}</th>
                <th style={{ ...TH_STYLE, textAlign: 'left' }}>{t('weeklyArenaColTrader')}</th>
                <th style={{ ...TH_STYLE, textAlign: 'left' }}>{t('weeklyArenaColExchange')}</th>
                <th style={TH_STYLE}>{t('weeklyArenaColRoi')}</th>
                <th style={TH_STYLE}>{t('weeklyArenaColPnl')}</th>
                <th style={TH_STYLE}>{t('weeklyArenaColWinRate')}</th>
                <th style={TH_STYLE}>{t('weeklyArenaColAsOf')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.source}:${row.exchangeTraderId}`}>
                  <td style={{ ...TD_STYLE, textAlign: 'left', fontWeight: 700 }}>
                    {i < 3 ? ['🥇', '🥈', '🥉'][i] : `#${i + 1}`}
                  </td>
                  <td style={{ ...TD_STYLE, textAlign: 'left' }}>
                    <Link
                      href={`/trader/${encodeURIComponent(row.exchangeTraderId)}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                        textDecoration: 'none',
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {row.avatarSrc ? (
                        <img
                          src={row.avatarSrc}
                          alt=""
                          width={24}
                          height={24}
                          style={{ borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }}
                        />
                      ) : (
                        <span
                          aria-hidden
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: '50%',
                            flexShrink: 0,
                            background: 'var(--color-bg-tertiary)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 11,
                            fontWeight: 700,
                            color: 'var(--color-text-tertiary)',
                          }}
                        >
                          {(row.nickname ?? row.exchangeTraderId).slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <Text
                        size="sm"
                        weight="bold"
                        style={{
                          display: 'inline-block',
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          verticalAlign: 'middle',
                        }}
                      >
                        {row.nickname ?? row.exchangeTraderId}
                      </Text>
                      {row.traderKind === 'bot' && (
                        <Text size="xs" color="tertiary">
                          {t('traderKindBot')}
                        </Text>
                      )}
                    </Link>
                  </td>
                  <td style={{ ...TD_STYLE, textAlign: 'left' }}>
                    <Box
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                      }}
                    >
                      {}
                      <img
                        src={getExchangeLogoUrl(row.source)}
                        alt={row.exchangeName}
                        width={16}
                        height={16}
                        style={{ borderRadius: tokens.radius.sm, flexShrink: 0 }}
                      />
                      <Text size="xs" color="secondary">
                        {row.exchangeName}
                      </Text>
                      {row.provenance.derived && <DerivedBoardBadge />}
                    </Box>
                  </td>
                  <td style={{ ...TD_STYLE, color: roiColor(row.roi), fontWeight: 700 }}>
                    {fmtRoi(row.roi)}
                  </td>
                  <td style={{ ...TD_STYLE, color: row.pnl ? roiColor(row.pnl.value) : undefined }}>
                    {row.pnl ? fmtMoney(row.pnl.value, row.pnl.currency) : '—'}
                  </td>
                  <td style={TD_STYLE}>
                    {row.winRate === null
                      ? '—'
                      : `${row.winRate.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}
                  </td>
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
        {t('weeklyArenaNote')}
      </Text>

      {/* ── BitMart official weekly arena — reference panel (spec §12.6) ── */}
      {bitmart && (
        <Box
          style={{
            marginTop: tokens.spacing[6],
            padding: tokens.spacing[4],
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.lg,
            background: 'var(--color-bg-secondary)',
          }}
        >
          <Box
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: tokens.spacing[2],
              marginBottom: tokens.spacing[3],
            }}
          >
            <Text size="md" weight="bold">
              {t('weeklyArenaBitmartTitle')}
            </Text>
            <Text size="xs" color="tertiary">
              {bitmart.startDate} → {bitmart.endDate} · {bitmart.year} W{bitmart.week}
            </Text>
          </Box>

          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: tokens.spacing[4],
            }}
          >
            {bitmart.categories.map((cat) => (
              <Box key={cat.key}>
                <Text
                  size="xs"
                  color="tertiary"
                  weight="bold"
                  style={{ display: 'block', marginBottom: tokens.spacing[2] }}
                >
                  {t(CATEGORY_I18N[cat.key])}
                </Text>
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                  {cat.entries.slice(0, 5).map((entry, i) => (
                    <Box
                      key={`${entry.name}-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: tokens.spacing[2],
                      }}
                    >
                      <Text
                        size="sm"
                        style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                      >
                        {i + 1}. {entry.name}
                        {entry.leverageLimit ? ` · ≤${entry.leverageLimit}x` : ''}
                      </Text>
                      <Text
                        size="sm"
                        weight="bold"
                        style={{
                          color: roiColor(entry.roiPct),
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {fmtRoi(entry.roiPct)}
                      </Text>
                    </Box>
                  ))}
                </Box>
              </Box>
            ))}
          </Box>

          <Text
            size="xs"
            color="tertiary"
            style={{ display: 'block', marginTop: tokens.spacing[3], opacity: 0.8 }}
          >
            {t('weeklyArenaBitmartNote')}
          </Text>
          {bitmart.fetchedAt && (
            <ProvenanceFooter
              provenance={{ source: 'bitmart_futures', asOf: bitmart.fetchedAt }}
              exchangeName="BitMart"
            />
          )}
        </Box>
      )}

      {newestAsOf && (
        <ProvenanceFooter provenance={{ source: 'arena', asOf: newestAsOf }} exchangeName="Arena" />
      )}
    </Box>
  )
}
