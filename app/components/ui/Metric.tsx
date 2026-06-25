/**
 * Metric — the single way to render a financial figure.
 *
 * Encodes DESIGN.md "Ledger Numerals" + "Numeric Hierarchy" + "Signal Accent":
 *  - tabular-nums + tight tracking so columns of numbers align like a ledger
 *  - size tier encodes importance (one hero number per view)
 *  - sign-aware color: gain=success, loss=error, neutral/zero/null=muted
 *  - optional small uppercase label above, optional delta arrow
 *
 * Pure (no hooks) so it renders in both server (SSRRankingTable) and client trees.
 *
 * @example
 *   <Metric value={trader.roi} format="roi" size="lg" />
 *   <Metric value={trader.pnl} format="pnl" size="sm" label="PnL" />
 *   <Metric value={sharpe} format="ratio" size="sm" label="Sharpe" />   // neutral, no color
 */
import React from 'react'
import { tokens } from '@/lib/design-tokens'
import {
  formatROI,
  formatPnL,
  formatPercent,
  formatRatio,
  formatCompact,
  formatNumber,
  formatCurrency,
  NULL_DISPLAY,
} from '@/lib/utils/format'

export type MetricFormat =
  | 'roi'
  | 'pnl'
  | 'percent'
  | 'ratio'
  | 'compact'
  | 'currency'
  | 'number'
  | 'raw'

export type MetricSize = 'hero' | 'lg' | 'md' | 'sm'

/** Size tier → (fontSize token, weight token). Mirrors DESIGN.md Numeric Hierarchy. */
const SIZE_MAP: Record<
  MetricSize,
  {
    size: keyof typeof tokens.typography.fontSize
    weight: keyof typeof tokens.typography.fontWeight
  }
> = {
  hero: { size: 'hero', weight: 'black' }, // 28 — the one headline number
  lg: { size: 'xl', weight: 'black' }, //   20 — card / leaderboard lead value
  md: { size: 'base', weight: 'bold' }, //  14 — standard row value
  sm: { size: 'sm', weight: 'semibold' }, // 13 — supporting stat
}

/** Formats that represent a signed outcome → colored by sign unless overridden. */
const SIGNED_FORMATS = new Set<MetricFormat>(['roi', 'pnl', 'percent', 'compact'])

function formatValue(value: number, format: MetricFormat): string {
  switch (format) {
    case 'roi':
      return formatROI(value)
    case 'pnl':
      return formatPnL(value)
    case 'percent':
      return formatPercent(value)
    case 'ratio':
      return formatRatio(value)
    case 'compact':
      return formatCompact(value)
    case 'currency':
      return formatCurrency(value)
    case 'number':
      return formatNumber(value)
    case 'raw':
    default:
      return String(value)
  }
}

export interface MetricProps {
  /** Numeric value. null/undefined/non-finite → renders the unified em-dash, neutral color. */
  value: number | null | undefined
  /** How to format the number. Defaults to 'number'. */
  format?: MetricFormat
  /** Pre-formatted string override — skips the formatter, sign color still derives from `value`. */
  display?: string
  size?: MetricSize
  /** Small uppercase label rendered above the value (e.g. "PnL", "WIN%"). */
  label?: string
  /** Force sign coloring on/off. Defaults: on for roi/pnl/percent/compact, off otherwise. */
  colorBySign?: boolean
  /** Render a ▲/▼ arrow before the value (only when sign-colored and non-zero). */
  showArrow?: boolean
  align?: 'left' | 'center' | 'right'
  as?: 'span' | 'div'
  className?: string
  style?: React.CSSProperties
  title?: string
}

export default function Metric({
  value,
  format = 'number',
  display,
  size = 'md',
  label,
  colorBySign,
  showArrow = false,
  align = 'left',
  as = 'div',
  className,
  style,
  title,
}: MetricProps) {
  const finite = value != null && Number.isFinite(value)
  const signed = colorBySign ?? SIGNED_FORMATS.has(format)
  const text = !finite ? NULL_DISPLAY : (display ?? formatValue(value as number, format))

  // Color: only signed formats with finite, non-zero values take a signal color.
  let color = 'var(--color-text-primary)'
  if (!finite) {
    color = 'var(--color-text-tertiary)'
  } else if (signed) {
    const v = value as number
    color =
      v > 0
        ? 'var(--color-accent-success)'
        : v < 0
          ? 'var(--color-accent-error)'
          : 'var(--color-text-secondary)'
  }

  const { size: sizeToken, weight } = SIZE_MAP[size]

  const arrow =
    showArrow && signed && finite && (value as number) !== 0
      ? (value as number) > 0
        ? '▲ ' // ▲
        : '▼ ' // ▼
      : ''

  const valueNode = (
    <span
      style={{
        fontSize: tokens.typography.fontSize[sizeToken],
        fontWeight: tokens.typography.fontWeight[weight],
        color,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.02em',
        lineHeight: tokens.typography.lineHeight.tight,
        whiteSpace: 'nowrap',
      }}
    >
      {arrow}
      {text}
    </span>
  )

  if (!label) {
    const Tag = as
    return (
      <Tag
        className={className}
        title={title}
        style={{ display: 'inline-flex', alignItems: 'baseline', ...style }}
      >
        {valueNode}
      </Tag>
    )
  }

  const items = align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start'
  return (
    <div
      className={className}
      title={title}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: items,
        gap: tokens.spacing[1],
        ...style,
      }}
    >
      <span
        style={{
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.medium,
          color: 'var(--color-text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          lineHeight: tokens.typography.lineHeight.tight,
        }}
      >
        {label}
      </span>
      {valueNode}
    </div>
  )
}
