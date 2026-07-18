'use client'

/**
 * Exchange Rankings client island (spec §6.1): timeframe switch + table.
 * All three timeframes arrive pre-fetched from the server component (ISR),
 * so switching is instant and the island never fetches.
 *
 * Leaderboard-bar parity (2026-06): sortable headers with aria-sort, sticky
 * thead + frozen exchange column, row drill-down to /exchange/[slug], colored
 * ROI/PnL cells routed through <Metric showArrow>, lazy logo with fallback,
 * and row hover affordance.
 */

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import PageHeader from '@/app/components/ui/PageHeader'
import Metric from '@/app/components/ui/Metric'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { getExchangeLogoUrl } from '@/lib/utils/avatar'
import DerivedBoardBadge from '@/app/components/common/DerivedBoardBadge'
import ProvenanceFooter from '@/app/components/common/ProvenanceFooter'
import ErrorState from '@/app/components/ui/ErrorState'
import { useTabsA11y } from '@/lib/hooks/useTabsA11y'
import {
  formatExchangeMoney,
  formatExchangePercent,
  formatExchangeTraderCount,
} from '@/lib/rankings/exchange-format'
import type {
  ExchangeRankingRow,
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

const SORT_BTN_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: tokens.spacing[1],
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

// ── Sorting ──────────────────────────────────────────────────────────────
type SortKey =
  | 'exchangeName'
  | 'rankedTraders'
  | 'medianRoi'
  | 'topDecileRoi'
  | 'pctProfitable'
  | 'copierPnl'
  | 'botShare'
  | 'asOf'
type SortDir = 'asc' | 'desc'

/** String columns default to ascending; everything else to descending. */
function defaultDir(key: SortKey): SortDir {
  return key === 'exchangeName' ? 'asc' : 'desc'
}

function sortValue(row: ExchangeRankingRow, key: SortKey): number | string | null {
  switch (key) {
    case 'exchangeName':
      return row.exchangeName.toLowerCase()
    case 'rankedTraders':
      return row.rankedTraders
    case 'medianRoi':
      return row.medianRoi
    case 'topDecileRoi':
      return row.topDecileRoi
    case 'pctProfitable':
      return row.pctProfitable
    case 'copierPnl':
      return row.copierPnl?.value ?? null
    case 'botShare':
      return row.botShare
    case 'asOf':
      return row.provenance.asOf
  }
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span aria-hidden="true" style={{ fontSize: '0.8em', opacity: active ? 1 : 0.3 }}>
      {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
    </span>
  )
}

function SortableTh({
  sortableKey,
  label,
  align,
  frozen,
  sortKey,
  sortDir,
  onSort,
  sortByLabel,
}: {
  sortableKey: SortKey
  label: string
  align: 'left' | 'right'
  frozen?: boolean
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  sortByLabel: string
}) {
  const active = sortableKey === sortKey
  const ariaSort = !active ? 'none' : sortDir === 'asc' ? 'ascending' : 'descending'
  return (
    <th
      aria-sort={ariaSort}
      style={{
        ...TH_STYLE,
        textAlign: align,
        position: 'sticky',
        top: 0,
        left: frozen ? 0 : undefined,
        zIndex: frozen ? 4 : 3,
        background: 'var(--color-bg-secondary)',
      }}
    >
      <button
        type="button"
        onClick={() => onSort(sortableKey)}
        aria-label={`${sortByLabel} ${label}`}
        style={{
          ...SORT_BTN_STYLE,
          justifyContent: align === 'left' ? 'flex-start' : 'flex-end',
          width: '100%',
        }}
      >
        <span>{label}</span>
        <SortIndicator active={active} dir={sortDir} />
      </button>
    </th>
  )
}

function ExchangeLogo({ source, name }: { source: string; name: string }) {
  const [errored, setErrored] = useState(false)
  if (errored) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          borderRadius: tokens.radius.sm,
          background: 'var(--color-bg-tertiary)',
          color: 'var(--color-text-tertiary)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: 700,
        }}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <img
      src={getExchangeLogoUrl(source)}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      decoding="async"
      onError={() => setErrored(true)}
      style={{ borderRadius: tokens.radius.sm, flexShrink: 0 }}
    />
  )
}

export interface ExchangeRankingsClientProps {
  byTimeframe: Record<ExchangeRankingsTimeframe, ExchangeRankings | null>
  failedTimeframes?: readonly ExchangeRankingsTimeframe[]
}

export default function ExchangeRankingsClient({
  byTimeframe,
  failedTimeframes = [],
}: ExchangeRankingsClientProps) {
  const { t, language } = useLanguage()
  const router = useRouter()
  const [isRetrying, startRetry] = useTransition()
  const [tf, setTf] = useState<ExchangeRankingsTimeframe>(90)
  // B2 tabs a11y: timeframe pills control the single rankings table region.
  const tfTabsA11y = useTabsA11y({
    tabs: TIMEFRAMES,
    active: tf,
    onChange: setTf,
    idPrefix: 'ex-tf',
    sharedPanelId: 'ex-results',
  })
  const [sortKey, setSortKey] = useState<SortKey>('rankedTraders')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const data = byTimeframe[tf]
  const selectedTimeframeFailed = failedTimeframes.includes(tf)
  const rows = useMemo(() => data?.rows ?? [], [data])

  const sortedRows = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const av = sortValue(a, sortKey)
      const bv = sortValue(b, sortKey)
      const aNull = av === null || av === undefined
      const bNull = bv === null || bv === undefined
      if (aNull && bNull) return 0
      if (aNull) return 1 // nulls always last
      if (bNull) return -1
      let cmp: number
      if (typeof av === 'string') cmp = av.localeCompare(bv as string)
      else cmp = (av as number) - (bv as number)
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [rows, sortKey, sortDir])

  const newestAsOf = rows.reduce<string | null>(
    (acc, r) => (acc === null || r.provenance.asOf > acc ? r.provenance.asOf : acc),
    null
  )

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(defaultDir(key))
    }
  }

  function retryFailedTimeframes() {
    startRetry(() => router.refresh())
  }

  const renderTh = (
    sortableKey: SortKey,
    label: string,
    align: 'left' | 'right',
    frozen?: boolean
  ) => (
    <SortableTh
      sortableKey={sortableKey}
      label={label}
      align={align}
      frozen={frozen}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={onSort}
      sortByLabel={t('sortBy')}
    />
  )

  return (
    <Box>
      {/* row hover + frozen-cell backgrounds (inline styles cannot express :hover) */}
      <style>{`
        .exr-row { cursor: pointer; }
        .exr-frozen { background: var(--color-bg-secondary); }
        .exr-row:hover td { background: var(--color-bg-tertiary); }
        .exr-row:hover .exr-frozen { background: var(--color-bg-tertiary); }
        .exr-row:focus-within td { background: var(--color-bg-tertiary); }
      `}</style>

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

        <Box
          style={{ display: 'flex', gap: tokens.spacing[1] }}
          {...tfTabsA11y.getTabListProps()}
          aria-label={t('exchangeRankingsTitle')}
        >
          {TIMEFRAMES.map((option) => (
            <button
              key={option}
              {...tfTabsA11y.getTabProps(option)}
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

      {failedTimeframes.length > 0 && !selectedTimeframeFailed && (
        <Box
          role="status"
          aria-busy={isRetrying}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.spacing[3],
            marginBottom: tokens.spacing[3],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.md,
            background: 'var(--color-bg-secondary)',
          }}
        >
          <Text size="sm" color="secondary">
            {t('dataLoadIncomplete')}
          </Text>
          <button
            type="button"
            onClick={retryFailedTimeframes}
            disabled={isRetrying}
            style={{
              border: 0,
              padding: tokens.spacing[1],
              color: 'var(--color-accent-primary)',
              background: 'transparent',
              cursor: isRetrying ? 'wait' : 'pointer',
              font: 'inherit',
              fontWeight: tokens.typography.fontWeight.semibold,
            }}
          >
            {isRetrying ? t('retrying') : t('retry')}
          </button>
        </Box>
      )}

      {selectedTimeframeFailed ? (
        <Box
          {...tfTabsA11y.getSharedPanelProps()}
          aria-busy={isRetrying}
          style={{
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.lg,
          }}
        >
          <ErrorState
            title={t('failedToLoadRankings')}
            description={t('loadFailedRetryShort')}
            retry={retryFailedTimeframes}
            variant="compact"
          />
        </Box>
      ) : rows.length === 0 ? (
        <Box
          {...tfTabsA11y.getSharedPanelProps()}
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
          {...tfTabsA11y.getSharedPanelProps()}
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
                {renderTh('exchangeName', t('exchangeRankingsColExchange'), 'left', true)}
                {renderTh('rankedTraders', t('exchangeRankingsColTraders'), 'right')}
                {renderTh('medianRoi', t('exchangeRankingsColMedianRoi'), 'right')}
                {renderTh('topDecileRoi', t('exchangeRankingsColTopDecileRoi'), 'right')}
                {renderTh('pctProfitable', t('exchangeRankingsColProfitable'), 'right')}
                {renderTh('copierPnl', t('exchangeRankingsColCopierPnl'), 'right')}
                {renderTh('botShare', t('exchangeRankingsColBotShare'), 'right')}
                {renderTh('asOf', t('exchangeRankingsColAsOf'), 'right')}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const href = `/exchange/${encodeURIComponent(row.exchangeSlug)}`
                return (
                  <tr key={row.source} className="exr-row" onClick={() => router.push(href)}>
                    <td
                      className="exr-frozen"
                      style={{
                        ...TD_STYLE,
                        textAlign: 'left',
                        position: 'sticky',
                        left: 0,
                        zIndex: 2,
                      }}
                    >
                      <Box
                        style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}
                      >
                        <ExchangeLogo source={row.source} name={row.exchangeName} />
                        <Link
                          href={href}
                          onClick={(e) => e.stopPropagation()}
                          style={{ textDecoration: 'none', color: 'var(--color-text-primary)' }}
                        >
                          <Text size="sm" weight="bold">
                            {row.exchangeName}
                          </Text>
                        </Link>
                        <Text size="xs" color="tertiary">
                          {t(PRODUCT_I18N[row.productType])}
                        </Text>
                        {row.provenance.derived && <DerivedBoardBadge />}
                      </Box>
                    </td>
                    <td style={TD_STYLE}>{formatExchangeTraderCount(row.rankedTraders)}</td>
                    <td style={TD_STYLE}>
                      <Metric
                        value={row.medianRoi}
                        format="roi"
                        display={formatExchangePercent(row.medianRoi, true)}
                        showArrow
                        size="sm"
                        as="span"
                      />
                    </td>
                    <td style={TD_STYLE}>
                      <Metric
                        value={row.topDecileRoi}
                        format="roi"
                        display={formatExchangePercent(row.topDecileRoi, true)}
                        showArrow
                        size="sm"
                        as="span"
                      />
                    </td>
                    <td style={TD_STYLE}>{formatExchangePercent(row.pctProfitable)}</td>
                    <td style={TD_STYLE}>
                      {row.copierPnl ? (
                        <Metric
                          value={row.copierPnl.value}
                          format="pnl"
                          display={formatExchangeMoney(row.copierPnl.value, row.copierPnl.currency)}
                          showArrow
                          size="sm"
                          as="span"
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={TD_STYLE}>{formatExchangePercent(row.botShare)}</td>
                    <td style={{ ...TD_STYLE, color: 'var(--color-text-tertiary)' }}>
                      <time
                        dateTime={row.provenance.asOf}
                        title={new Date(row.provenance.asOf).toLocaleString()}
                        suppressHydrationWarning
                      >
                        {formatTimeAgo(row.provenance.asOf, language)}
                      </time>
                    </td>
                  </tr>
                )
              })}
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
