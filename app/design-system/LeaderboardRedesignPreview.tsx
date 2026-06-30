'use client'

/**
 * Leaderboard Redesign Prototype (Wave 4)
 * ----------------------------------------
 * SELF-CONTAINED visual prototype for review. Uses MOCK data only.
 * Does NOT import or modify any live ranking component.
 *
 * Demonstrates the Wave-4 leaderboard improvements from
 * docs/UIUX_AUDIT_2026-06-29.md §1 & §4:
 *   1. Density toggle (compact / comfortable) → data-density drives row height
 *   2. Sticky header with aria-sort on sortable columns
 *   3. Frozen first column (rank + name) on horizontal scroll at narrow width
 *   4. Inline per-row visualization: real Sparkline (rank-history data[]) + arena-score mini-bar
 *   5. Mobile card layout (≤768px) instead of column-dropping (rendered alongside as a preview)
 *   6. Colorblind-safe up/down: red/green + Metric showArrow shape cue
 */

import React, { useMemo, useState } from 'react'
import { tokens, alpha, rankColors } from '@/lib/design-tokens'
import Metric from '@/app/components/ui/Metric'
import { Sparkline } from '@/app/components/ui/Sparkline'
import EmptyState from '@/app/components/ui/EmptyState'

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

interface MockTrader {
  rank: number
  name: string
  handle: string
  roi: number
  pnl: number
  winRate: number
  mdd: number
  arenaScore: number
  /** rank history (lower = better rank); we invert for the sparkline so "up = improving" */
  rankHistory: number[]
}

const MOCK_TRADERS: MockTrader[] = [
  {
    rank: 1,
    name: 'Hyperion',
    handle: '0x9f3a…b21c',
    roi: 412.6,
    pnl: 2_840_500,
    winRate: 71.2,
    mdd: 18.4,
    arenaScore: 96,
    rankHistory: [12, 9, 7, 5, 3, 2, 1],
  },
  {
    rank: 2,
    name: 'NovaQuant',
    handle: 'nova.eth',
    roi: 287.3,
    pnl: 1_920_300,
    winRate: 68.5,
    mdd: 22.1,
    arenaScore: 92,
    rankHistory: [3, 4, 3, 2, 2, 3, 2],
  },
  {
    rank: 3,
    name: 'Meridian',
    handle: '0x44de…91a0',
    roi: 233.9,
    pnl: 1_512_770,
    winRate: 64.8,
    mdd: 27.6,
    arenaScore: 88,
    rankHistory: [8, 6, 5, 4, 4, 3, 3],
  },
  {
    rank: 4,
    name: 'GammaEdge',
    handle: 'gamma.sol',
    roi: 198.4,
    pnl: 1_104_220,
    winRate: 61.0,
    mdd: 31.2,
    arenaScore: 84,
    rankHistory: [2, 2, 3, 3, 4, 4, 4],
  },
  {
    rank: 5,
    name: 'BlueWhale88',
    handle: '0x7c12…ffae',
    roi: 156.7,
    pnl: 884_900,
    winRate: 59.3,
    mdd: 34.8,
    arenaScore: 80,
    rankHistory: [10, 9, 8, 7, 6, 5, 5],
  },
  {
    rank: 6,
    name: 'Solaris',
    handle: 'solaris.eth',
    roi: 121.2,
    pnl: 642_100,
    winRate: 57.1,
    mdd: 29.0,
    arenaScore: 76,
    rankHistory: [5, 5, 6, 6, 6, 6, 6],
  },
  {
    rank: 7,
    name: 'KaitoFi',
    handle: '0xab90…2d44',
    roi: 88.5,
    pnl: 401_350,
    winRate: 54.4,
    mdd: 41.3,
    arenaScore: 71,
    rankHistory: [4, 5, 6, 6, 7, 7, 7],
  },
  {
    rank: 8,
    name: 'ZenTrader',
    handle: 'zen.base',
    roi: 44.1,
    pnl: 188_700,
    winRate: 52.0,
    mdd: 38.9,
    arenaScore: 66,
    rankHistory: [6, 6, 7, 7, 8, 8, 8],
  },
  {
    rank: 9,
    name: 'OrbitCap',
    handle: '0x1188…77ce',
    roi: 12.8,
    pnl: 54_200,
    winRate: 50.6,
    mdd: 44.2,
    arenaScore: 61,
    rankHistory: [7, 8, 8, 9, 9, 9, 9],
  },
  {
    rank: 10,
    name: 'DeltaOne',
    handle: 'delta.eth',
    roi: -8.3,
    pnl: -22_900,
    winRate: 47.9,
    mdd: 52.7,
    arenaScore: 54,
    rankHistory: [9, 9, 10, 10, 10, 10, 10],
  },
  {
    rank: 11,
    name: 'RektPhoenix',
    handle: '0xdead…beef',
    roi: -27.5,
    pnl: -96_400,
    winRate: 43.2,
    mdd: 61.8,
    arenaScore: 47,
    rankHistory: [8, 9, 10, 11, 11, 11, 11],
  },
  {
    rank: 12,
    name: 'LunaLost',
    handle: 'luna.terra',
    roi: -54.9,
    pnl: -312_050,
    winRate: 38.7,
    mdd: 78.5,
    arenaScore: 39,
    rankHistory: [10, 11, 11, 12, 12, 12, 12],
  },
]

// ---------------------------------------------------------------------------
// Sort model
// ---------------------------------------------------------------------------

type SortKey = 'rank' | 'roi' | 'pnl' | 'winRate' | 'mdd' | 'arenaScore'
type SortDir = 'asc' | 'desc'
type AriaSort = 'ascending' | 'descending' | 'none'

const COLUMNS: { key: SortKey; label: string; sortable: boolean; align: 'left' | 'right' }[] = [
  { key: 'roi', label: 'ROI', sortable: true, align: 'right' },
  { key: 'pnl', label: 'PnL', sortable: true, align: 'right' },
  { key: 'winRate', label: 'Win %', sortable: true, align: 'right' },
  { key: 'mdd', label: 'Max DD', sortable: true, align: 'right' },
  { key: 'arenaScore', label: 'Arena Score', sortable: true, align: 'right' },
]

// ---------------------------------------------------------------------------
// Density model
// ---------------------------------------------------------------------------

type Density = 'compact' | 'comfortable'

const DENSITY: Record<Density, { rowH: number; padY: string; padX: string; sparkH: number }> = {
  compact: { rowH: 44, padY: tokens.spacing[2], padX: tokens.spacing[3], sparkH: 20 },
  comfortable: { rowH: 64, padY: tokens.spacing[4], padX: tokens.spacing[4], sparkH: 28 },
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function RankMedal({ rank }: { rank: number }) {
  const medal =
    rank === 1
      ? rankColors.gold
      : rank === 2
        ? rankColors.silver
        : rank === 3
          ? rankColors.bronze
          : null
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 26,
        height: 26,
        padding: `0 ${tokens.spacing[1]}`,
        borderRadius: tokens.radius.sm,
        fontSize: tokens.typography.fontSize.sm,
        fontWeight: tokens.typography.fontWeight.bold,
        fontVariantNumeric: 'tabular-nums',
        color: medal ? '#0B0A10' : 'var(--color-text-secondary)',
        background: medal ? medal : alpha(tokens.colors.text.tertiary, 12),
      }}
    >
      {rank}
    </span>
  )
}

function Avatar({ name }: { name: string }) {
  const initials = name.slice(0, 2).toUpperCase()
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        flexShrink: 0,
        borderRadius: tokens.radius.full,
        background: tokens.gradient.primarySubtle,
        border: `1px solid ${alpha(tokens.colors.accent.primary, 22)}`,
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: tokens.typography.fontWeight.bold,
        color: 'var(--color-text-secondary)',
      }}
    >
      {initials}
    </span>
  )
}

/** Token-styled arena-score mini-bar: score / 100, color graded by tier. */
function ScoreMiniBar({ score, width = 64 }: { score: number; width?: number }) {
  const pct = Math.max(0, Math.min(score, 100))
  const color =
    score >= 85
      ? tokens.colors.accent.success
      : score >= 60
        ? tokens.colors.accent.primary
        : score >= 45
          ? tokens.colors.accent.warning
          : tokens.colors.accent.error
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        justifyContent: 'flex-end',
      }}
    >
      <Metric value={score} format="number" size="sm" />
      <div
        role="img"
        aria-label={`Arena score ${score} of 100`}
        style={{
          width,
          height: 6,
          borderRadius: tokens.radius.full,
          background: alpha(tokens.colors.text.tertiary, 14),
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: tokens.radius.full,
            background: color,
          }}
        />
      </div>
    </div>
  )
}

/** Sparkline from rank history. Lower rank number = better, so invert for an "up = good" curve. */
function RankSpark({ trader, height }: { trader: MockTrader; height: number }) {
  const data = trader.rankHistory.map((r) => -r)
  const improving = trader.rankHistory[trader.rankHistory.length - 1] <= trader.rankHistory[0]
  return (
    <Sparkline
      data={data}
      width={76}
      height={height}
      color={improving ? tokens.colors.sentiment.bull : tokens.colors.sentiment.bear}
      ariaLabel={`Rank trend over ${data.length} snapshots: ${improving ? 'improving' : 'declining'}`}
    />
  )
}

// ---------------------------------------------------------------------------
// Desktop table variant
// ---------------------------------------------------------------------------

function DesktopTable({
  rows,
  density,
  sortKey,
  sortDir,
  onSort,
}: {
  rows: MockTrader[]
  density: Density
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
}) {
  const d = DENSITY[density]
  const headBg = 'var(--color-bg-secondary)'
  const borderColor = 'var(--color-border-secondary)'

  // Frozen-column style (rank + name). z-index keeps it above scrolling cells.
  const frozenCell: React.CSSProperties = {
    position: 'sticky',
    left: 0,
    background: 'var(--color-bg-primary)',
    zIndex: 1,
    boxShadow: `1px 0 0 ${borderColor}`,
  }

  const ariaSortFor = (key: SortKey): AriaSort =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'

  const sortGlyph = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : '↕')

  return (
    <div
      data-density={density}
      style={{
        border: `1px solid ${borderColor}`,
        borderRadius: tokens.radius.lg,
        overflow: 'hidden',
        background: 'var(--color-bg-primary)',
      }}
    >
      {/* Scroll container — narrow maxWidth to demonstrate the frozen first column */}
      <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <table
          style={{
            width: '100%',
            minWidth: 880,
            borderCollapse: 'separate',
            borderSpacing: 0,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <thead>
            <tr>
              {/* Frozen header: Trader (rank + name) */}
              <th
                scope="col"
                aria-sort={ariaSortFor('rank')}
                style={{
                  ...frozenCell,
                  position: 'sticky',
                  top: 0,
                  zIndex: 3,
                  background: headBg,
                  textAlign: 'left',
                  padding: `${tokens.spacing[2]} ${d.padX}`,
                  borderBottom: `1px solid ${borderColor}`,
                  minWidth: 200,
                }}
              >
                <SortButton
                  label="Trader"
                  active={sortKey === 'rank'}
                  glyph={sortGlyph('rank')}
                  align="left"
                  onClick={() => onSort('rank')}
                />
              </th>

              {/* Trend (not sortable) */}
              <th
                scope="col"
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 2,
                  background: headBg,
                  textAlign: 'left',
                  padding: `${tokens.spacing[2]} ${d.padX}`,
                  borderBottom: `1px solid ${borderColor}`,
                  ...colLabelStyle,
                }}
              >
                Rank trend
              </th>

              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSortFor(col.key)}
                  style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                    background: headBg,
                    textAlign: col.align,
                    padding: `${tokens.spacing[2]} ${d.padX}`,
                    borderBottom: `1px solid ${borderColor}`,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <SortButton
                    label={col.label}
                    active={sortKey === col.key}
                    glyph={sortGlyph(col.key)}
                    align={col.align}
                    onClick={() => onSort(col.key)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.rank}
                style={{ height: d.rowH, transition: tokens.transition.colors }}
                className="ldb-redesign-row"
              >
                {/* Frozen first column: rank medal + avatar + name */}
                <td
                  style={{
                    ...frozenCell,
                    padding: `${d.padY} ${d.padX}`,
                    borderBottom: `1px solid ${alpha(tokens.colors.border.secondary, 60)}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2.5] }}>
                    <RankMedal rank={t.rank} />
                    <Avatar name={t.name} />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: tokens.typography.fontSize.base,
                          fontWeight: tokens.typography.fontWeight.semibold,
                          color: 'var(--color-text-primary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          maxWidth: 120,
                        }}
                      >
                        {t.name}
                      </div>
                      <div
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          color: 'var(--color-text-tertiary)',
                          fontFamily: tokens.typography.fontFamily.mono.join(', '),
                        }}
                      >
                        {t.handle}
                      </div>
                    </div>
                  </div>
                </td>

                {/* Inline sparkline */}
                <td style={dataCell(d)}>
                  <RankSpark trader={t} height={d.sparkH} />
                </td>

                {/* ROI — colorblind-safe arrow cue */}
                <td style={{ ...dataCell(d), textAlign: 'right' }}>
                  <Metric value={t.roi} format="roi" size="md" align="right" showArrow />
                </td>

                {/* PnL — colorblind-safe arrow cue */}
                <td style={{ ...dataCell(d), textAlign: 'right' }}>
                  <Metric value={t.pnl} format="compact" size="md" align="right" showArrow />
                </td>

                {/* Win rate — neutral percent */}
                <td style={{ ...dataCell(d), textAlign: 'right' }}>
                  <Metric
                    value={t.winRate}
                    format="percent"
                    size="sm"
                    align="right"
                    colorBySign={false}
                  />
                </td>

                {/* Max drawdown — risk, render as negative so it reads as a loss cue */}
                <td style={{ ...dataCell(d), textAlign: 'right' }}>
                  <Metric value={-t.mdd} format="percent" size="sm" align="right" showArrow />
                </td>

                {/* Arena score mini-bar */}
                <td style={{ ...dataCell(d), textAlign: 'right' }}>
                  <ScoreMiniBar score={t.arenaScore} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const colLabelStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.xs,
  fontWeight: tokens.typography.fontWeight.semibold,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  whiteSpace: 'nowrap',
}

function dataCell(d: (typeof DENSITY)[Density]): React.CSSProperties {
  return {
    padding: `${d.padY} ${d.padX}`,
    borderBottom: `1px solid ${alpha(tokens.colors.border.secondary, 60)}`,
    verticalAlign: 'middle',
  }
}

function SortButton({
  label,
  active,
  glyph,
  align,
  onClick,
}: {
  label: string
  active: boolean
  glyph: string
  align: 'left' | 'right'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: tokens.spacing[1],
        flexDirection: align === 'right' ? 'row-reverse' : 'row',
        width: '100%',
        justifyContent: align === 'right' ? 'flex-start' : 'flex-start',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        ...colLabelStyle,
        color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
      }}
    >
      <span>{label}</span>
      <span aria-hidden="true" style={{ fontSize: '0.85em', opacity: active ? 1 : 0.5 }}>
        {glyph}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Mobile card variant (≤768px strategy: cards, not column-dropping)
// ---------------------------------------------------------------------------

function MobileCards({ rows }: { rows: MockTrader[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2.5] }}>
      {rows.map((t) => (
        <div
          key={t.rank}
          style={{
            border: '1px solid var(--color-border-secondary)',
            borderRadius: tokens.radius.lg,
            background: 'var(--color-bg-secondary)',
            padding: tokens.spacing[3],
          }}
        >
          {/* Header row: rank + name + sparkline */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              marginBottom: tokens.spacing[3],
            }}
          >
            <RankMedal rank={t.rank} />
            <Avatar name={t.name} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: tokens.typography.fontSize.base,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  color: 'var(--color-text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {t.name}
              </div>
              <div
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: 'var(--color-text-tertiary)',
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                }}
              >
                {t.handle}
              </div>
            </div>
            <RankSpark trader={t} height={24} />
          </div>

          {/* Metric grid — nothing dropped, just reflowed */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: tokens.spacing[3],
              marginBottom: tokens.spacing[3],
            }}
          >
            <Metric value={t.roi} format="roi" size="md" label="ROI" showArrow />
            <Metric value={t.pnl} format="compact" size="md" label="PnL" align="right" showArrow />
            <Metric
              value={t.winRate}
              format="percent"
              size="sm"
              label="Win %"
              colorBySign={false}
            />
            <Metric
              value={-t.mdd}
              format="percent"
              size="sm"
              label="Max DD"
              align="right"
              showArrow
            />
          </div>

          {/* Score bar full width */}
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <span style={colLabelStyle}>Score</span>
            <div style={{ flex: 1 }}>
              <ScoreMiniBar score={t.arenaScore} width={120} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function DensityToggle({
  density,
  onChange,
}: {
  density: Density
  onChange: (d: Density) => void
}) {
  const options: { value: Density; label: string }[] = [
    { value: 'compact', label: 'Compact' },
    { value: 'comfortable', label: 'Comfortable' },
  ]
  return (
    <div
      role="group"
      aria-label="Row density"
      style={{
        display: 'inline-flex',
        padding: tokens.spacing[0.5],
        gap: tokens.spacing[0.5],
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border-secondary)',
        borderRadius: tokens.radius.md,
      }}
    >
      {options.map((opt) => {
        const active = density === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            style={{
              padding: `${tokens.spacing[1.5]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.sm,
              border: 'none',
              cursor: 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              background: active ? tokens.gradient.primary : 'transparent',
              color: active ? '#fff' : 'var(--color-text-secondary)',
              transition: tokens.transition.colors,
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Top-level prototype
// ---------------------------------------------------------------------------

export default function LeaderboardRedesignPreview() {
  const [density, setDensity] = useState<Density>('comfortable')
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [showEmpty, setShowEmpty] = useState(false)

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // Default: rank ascending (best first); metrics descending (best first)
      setSortDir(key === 'rank' ? 'asc' : 'desc')
    }
  }

  const sortedRows = useMemo(() => {
    const rows = [...MOCK_TRADERS]
    rows.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const cmp = av === bv ? 0 : av < bv ? -1 : 1
      return sortDir === 'asc' ? cmp : -cmp
    })
    return rows
  }, [sortKey, sortDir])

  const sectionTitle: React.CSSProperties = {
    fontSize: tokens.typography.fontSize.sm,
    fontWeight: tokens.typography.fontWeight.bold,
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    margin: `${tokens.spacing[6]} 0 ${tokens.spacing[3]}`,
  }

  return (
    <section
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: tokens.spacing[6],
        color: 'var(--color-text-primary)',
      }}
    >
      {/* Heading */}
      <header style={{ marginBottom: tokens.spacing[5] }}>
        <h1
          style={{
            fontSize: tokens.typography.fontSize['2xl'],
            fontWeight: tokens.typography.fontWeight.black,
            margin: 0,
            letterSpacing: '-0.02em',
          }}
        >
          Leaderboard redesign prototype (Wave 4)
        </h1>
        <p
          style={{
            fontSize: tokens.typography.fontSize.base,
            color: 'var(--color-text-tertiary)',
            lineHeight: tokens.typography.lineHeight.normal,
            maxWidth: 720,
            marginTop: tokens.spacing[2],
          }}
        >
          Self-contained mock prototype for the Wave-4 table improvements (audit §1 &amp; §4).
          Nothing here touches the live <code>RankingTable</code>. Demonstrates: density toggle,
          sticky header with <code>aria-sort</code>, frozen first column on horizontal scroll,
          inline rank-trend sparkline + arena-score mini-bar, a mobile card layout, and
          colorblind-safe up/down via <code>Metric showArrow</code>.
        </p>
      </header>

      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[4],
          flexWrap: 'wrap',
          marginBottom: tokens.spacing[2],
        }}
      >
        <DensityToggle density={density} onChange={setDensity} />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-secondary)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={showEmpty}
            onChange={(e) => setShowEmpty(e.target.checked)}
          />
          Preview empty state
        </label>
        <span
          style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)' }}
        >
          Sorted by <strong>{sortKey}</strong> ({sortDir}) — click any header to re-sort.
        </span>
      </div>

      {/* Desktop table */}
      <div style={sectionTitle}>
        Desktop table — sticky header · frozen first column · inline viz
      </div>
      <p
        style={{
          fontSize: tokens.typography.fontSize.xs,
          color: 'var(--color-text-tertiary)',
          marginTop: 0,
          marginBottom: tokens.spacing[3],
        }}
      >
        The table has a fixed <code>min-width</code>; on a narrow viewport (or this constrained box)
        it scrolls horizontally while the rank + name column stays frozen on the left.
      </p>

      {showEmpty ? (
        <EmptyState
          variant="card"
          icon="🏆"
          title="No traders match these filters"
          description="Try widening the timeframe or clearing exchange filters to see the full leaderboard."
        />
      ) : (
        <DesktopTable
          rows={sortedRows}
          density={density}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
      )}

      {/* Mobile cards */}
      <div style={sectionTitle}>Mobile card layout (≤768px) — reflow, not column-dropping</div>
      <p
        style={{
          fontSize: tokens.typography.fontSize.xs,
          color: 'var(--color-text-tertiary)',
          marginTop: 0,
          marginBottom: tokens.spacing[3],
        }}
      >
        Below the <code>md</code> breakpoint the table becomes cards so every metric stays visible.
        Shown here in a fixed 360px frame to simulate a phone.
      </p>
      <div
        style={{
          width: 360,
          maxWidth: '100%',
          border: '1px dashed var(--color-border-secondary)',
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[3],
          background: 'var(--color-bg-primary)',
        }}
      >
        <MobileCards rows={sortedRows.slice(0, 5)} />
      </div>

      <p
        style={{
          marginTop: tokens.spacing[6],
          fontSize: tokens.typography.fontSize.xs,
          color: 'var(--color-text-tertiary)',
          lineHeight: tokens.typography.lineHeight.normal,
        }}
      >
        Colorblind-safe note: gains/losses keep the trader-familiar red/green but every signed
        figure also carries a +/− sign and a ▲/▼ shape cue (via <code>Metric showArrow</code>), and
        sparkline direction is encoded by the end-marker position — so direction never relies on hue
        alone.
      </p>
    </section>
  )
}
