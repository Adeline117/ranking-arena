'use client'

/**
 * Weekly Cross-Exchange ROI Arena client island (spec §12.6): pooled 7d-ROI
 * podium + table across serving sources, with BitMart's official weekly
 * arena as a reference panel. Data arrives pre-fetched from the server
 * component (ISR 1800) — the island never fetches.
 *
 * Leaderboard-bar parity (2026-06): a real 3-up podium for the top-3, pooled
 * week range in the header, sortable headers with aria-sort, sticky thead +
 * frozen rank/trader columns, ROI/PnL routed through <Metric showArrow>, a
 * share affordance, and lazy avatars/logos with fallbacks.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { tokens, rankColors } from '@/lib/design-tokens'
import PageHeader from '@/app/components/ui/PageHeader'
import Metric from '@/app/components/ui/Metric'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { getExchangeLogoUrl } from '@/lib/utils/avatar'
import DerivedBoardBadge from '@/app/components/common/DerivedBoardBadge'
import ProvenanceFooter from '@/app/components/common/ProvenanceFooter'
import {
  formatWeeklyMoney,
  formatWeeklyRange,
  formatWeeklyRoi,
  formatWeeklyWinRate,
} from '@/lib/rankings/weekly-format'
import type {
  BitmartWeeklyCategoryKey,
  WeeklyLeaderRow,
  WeeklyLeaders,
} from '@/lib/data/serving/weekly-leaders'

const CATEGORY_I18N: Record<BitmartWeeklyCategoryKey, string> = {
  open: 'weeklyArenaCategoryOpen',
  low_lev: 'weeklyArenaCategoryLowLev',
  protected: 'weeklyArenaCategoryProtected',
}

const MEDALS = ['🥇', '🥈', '🥉'] as const
const MEDAL_RING = [rankColors.gold, rankColors.silver, rankColors.bronze] as const
const RANK_COL_WIDTH = 64 // px — fixed so the frozen trader column can offset by it

function roiColor(v: number): string {
  return v >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
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
type SortKey = 'trader' | 'exchange' | 'roi' | 'pnl' | 'winRate' | 'asOf'
type SortDir = 'asc' | 'desc'

function defaultDir(key: SortKey): SortDir {
  return key === 'trader' || key === 'exchange' ? 'asc' : 'desc'
}

function sortValue(row: WeeklyLeaderRow, key: SortKey): number | string | null {
  switch (key) {
    case 'trader':
      return (row.nickname ?? row.exchangeTraderId).toLowerCase()
    case 'exchange':
      return row.exchangeName.toLowerCase()
    case 'roi':
      return row.roi
    case 'pnl':
      return row.pnl?.value ?? null
    case 'winRate':
      return row.winRate
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
  left,
  width,
  sortKey,
  sortDir,
  onSort,
  sortByLabel,
}: {
  sortableKey: SortKey
  label: string
  align: 'left' | 'right'
  frozen?: boolean
  left?: number
  width?: number
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
        width,
        position: 'sticky',
        top: 0,
        left: frozen ? (left ?? 0) : undefined,
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

function TraderAvatar({ row, size }: { row: WeeklyLeaderRow; size: number }) {
  if (row.avatarSrc) {
    return (
      <img
        src={row.avatarSrc}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        style={{ borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        background: 'var(--color-bg-tertiary)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: 700,
        color: 'var(--color-text-tertiary)',
      }}
    >
      {(row.nickname ?? row.exchangeTraderId).slice(0, 1).toUpperCase()}
    </span>
  )
}

function ExchangeLogo({ source, name, size }: { source: string; name: string; size: number }) {
  const [errored, setErrored] = useState(false)
  if (errored) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
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
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setErrored(true)}
      style={{ borderRadius: tokens.radius.sm, flexShrink: 0 }}
    />
  )
}

function PodiumCard({ row, place }: { row: WeeklyLeaderRow; place: number }) {
  return (
    <Link
      href={`/trader/${encodeURIComponent(row.exchangeTraderId)}`}
      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
    >
      <Box
        className="weekly-podium-card"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[2],
          textAlign: 'center',
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.lg,
          border: '1px solid var(--color-border-primary)',
          borderTop: `3px solid ${MEDAL_RING[place]}`,
          background: 'var(--color-bg-secondary)',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: tokens.typography.fontSize.xl }}>
          {MEDALS[place]}
        </span>
        <TraderAvatar row={row} size={48} />
        <Text
          size="sm"
          weight="bold"
          title={row.nickname ?? row.exchangeTraderId}
          style={{
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.nickname ?? row.exchangeTraderId}
        </Text>
        <Box style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacing[1] }}>
          <ExchangeLogo source={row.source} name={row.exchangeName} size={14} />
          <Text size="xs" color="secondary">
            {row.exchangeName}
          </Text>
        </Box>
        <Metric
          className="weekly-podium-roi"
          value={row.roi}
          format="roi"
          display={formatWeeklyRoi(row.roi)}
          showArrow
          size="lg"
          as="span"
          style={{ maxWidth: '100%' }}
        />
      </Box>
    </Link>
  )
}

export interface WeeklyArenaClientProps {
  data: WeeklyLeaders
}

export default function WeeklyArenaClient({ data }: WeeklyArenaClientProps) {
  const { t, language } = useLanguage()
  const { rows, bitmart } = data
  const [sortKey, setSortKey] = useState<SortKey>('roi')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  // Canonical pooled ranking is by ROI — podium always reflects that, regardless
  // of how the user re-sorts the explorable table below.
  const podium = useMemo(() => [...rows].sort((a, b) => b.roi - a.roi).slice(0, 3), [rows])

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

  // Pooled week window: the 7-day span ending at the freshest snapshot.
  const weekRange = useMemo(() => formatWeeklyRange(newestAsOf, language), [newestAsOf, language])

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(defaultDir(key))
    }
  }

  const renderTh = (
    sortableKey: SortKey,
    label: string,
    align: 'left' | 'right',
    opts?: { frozen?: boolean; left?: number; width?: number }
  ) => (
    <SortableTh
      sortableKey={sortableKey}
      label={label}
      align={align}
      frozen={opts?.frozen}
      left={opts?.left}
      width={opts?.width}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={onSort}
      sortByLabel={t('sortBy')}
    />
  )

  async function onShare() {
    const url = typeof window !== 'undefined' ? window.location.href : ''
    if (!url) return
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav?.share) {
      try {
        await nav.share({ title: t('weeklyArenaTitle'), url })
        return
      } catch {
        // user dismissed the share sheet — fall through to clipboard
      }
    }
    try {
      // Guard BEFORE awaiting: `nav?.clipboard?.writeText` short-circuits to
      // undefined (no throw) when the Clipboard API is missing, which would
      // falsely report success below.
      if (!nav?.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await nav.clipboard.writeText(url)
      setCopyFailed(false)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      // clipboard blocked (insecure context / permissions) — surface it on the button
      console.warn('[WeeklyArena] copy link failed:', err)
      setCopied(false)
      setCopyFailed(true)
      setTimeout(() => setCopyFailed(false), 2000)
    }
  }

  return (
    <Box>
      {/* row hover + frozen-cell backgrounds (inline styles cannot express :hover) */}
      <style>{`
        .wka-frozen { background: var(--color-bg-secondary); }
        .wka-row:hover td { background: var(--color-bg-tertiary); }
        .wka-row:hover .wka-frozen { background: var(--color-bg-tertiary); }
        .wka-row:focus-within td { background: var(--color-bg-tertiary); }
      `}</style>

      <Box
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: tokens.spacing[3],
        }}
      >
        <Box>
          <PageHeader title={t('weeklyArenaTitle')} subtitle={t('weeklyArenaSubtitle')} compact />
          {weekRange && (
            <Text
              size="xs"
              color="tertiary"
              style={{ display: 'block', marginTop: tokens.spacing[1] }}
            >
              {weekRange}
            </Text>
          )}
        </Box>

        {rows.length > 0 && (
          <button
            type="button"
            onClick={onShare}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              color: copyFailed ? 'var(--color-error)' : 'var(--color-text-secondary)',
              background: 'transparent',
              border: '1px solid var(--color-border-primary)',
              borderRadius: tokens.radius.md,
              cursor: 'pointer',
            }}
          >
            {copied ? t('linkCopied') : copyFailed ? t('copyFailed') : t('share')}
          </button>
        )}
      </Box>

      {rows.length === 0 ? (
        <Box
          style={{
            marginTop: tokens.spacing[4],
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
        <>
          {/* ── Top-3 podium (canonical ROI ranking) ── */}
          {podium.length > 0 && (
            <Box
              className="weekly-podium-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: tokens.spacing[3],
                marginTop: tokens.spacing[4],
                marginBottom: tokens.spacing[4],
              }}
            >
              {podium.map((row, i) => (
                <PodiumCard key={`${row.source}:${row.exchangeTraderId}`} row={row} place={i} />
              ))}
            </Box>
          )}

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
                  {/* Rank — positional, not sortable, but frozen */}
                  <th
                    style={{
                      ...TH_STYLE,
                      textAlign: 'left',
                      width: RANK_COL_WIDTH,
                      position: 'sticky',
                      top: 0,
                      left: 0,
                      zIndex: 4,
                      background: 'var(--color-bg-secondary)',
                    }}
                  >
                    {t('weeklyArenaColRank')}
                  </th>
                  {renderTh('trader', t('weeklyArenaColTrader'), 'left', {
                    frozen: true,
                    left: RANK_COL_WIDTH,
                  })}
                  {renderTh('exchange', t('weeklyArenaColExchange'), 'left')}
                  {renderTh('roi', t('weeklyArenaColRoi'), 'right')}
                  {renderTh('pnl', t('weeklyArenaColPnl'), 'right')}
                  {renderTh('winRate', t('weeklyArenaColWinRate'), 'right')}
                  {renderTh('asOf', t('weeklyArenaColAsOf'), 'right')}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, i) => (
                  <tr key={`${row.source}:${row.exchangeTraderId}`} className="wka-row">
                    <td
                      className="wka-frozen"
                      style={{
                        ...TD_STYLE,
                        textAlign: 'left',
                        fontWeight: 700,
                        width: RANK_COL_WIDTH,
                        position: 'sticky',
                        left: 0,
                        zIndex: 2,
                      }}
                    >
                      {i < 3 ? MEDALS[i] : `#${i + 1}`}
                    </td>
                    <td
                      className="wka-frozen"
                      style={{
                        ...TD_STYLE,
                        textAlign: 'left',
                        position: 'sticky',
                        left: RANK_COL_WIDTH,
                        zIndex: 2,
                        boxShadow: '6px 0 8px -4px var(--color-overlay-medium)',
                      }}
                    >
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
                        <TraderAvatar row={row} size={24} />
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
                        <ExchangeLogo source={row.source} name={row.exchangeName} size={16} />
                        <Text size="xs" color="secondary">
                          {row.exchangeName}
                        </Text>
                        {row.provenance.derived && <DerivedBoardBadge />}
                      </Box>
                    </td>
                    <td style={TD_STYLE}>
                      <Metric
                        value={row.roi}
                        format="roi"
                        display={formatWeeklyRoi(row.roi)}
                        showArrow
                        size="sm"
                        as="span"
                      />
                    </td>
                    <td style={TD_STYLE}>
                      {row.pnl ? (
                        <Metric
                          value={row.pnl.value}
                          format="pnl"
                          display={formatWeeklyMoney(row.pnl.value, row.pnl.currency)}
                          showArrow
                          size="sm"
                          as="span"
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={TD_STYLE}>{formatWeeklyWinRate(row.winRate)}</td>
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
                ))}
              </tbody>
            </table>
          </Box>
        </>
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
                        {formatWeeklyRoi(entry.roiPct)}
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
