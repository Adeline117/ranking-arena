'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { t as i18nT } from '@/lib/i18n'
import { getPlatformNote } from '@/lib/constants/platform-metrics'
import { useCountUp } from '@/lib/hooks/useCountUp'
import { formatROI } from './utils'
import Metric from '../ui/Metric'
import { formatDrawdown, NULL_DISPLAY } from '@/lib/utils/format'
import type { Trader } from './RankingTable'
import {
  NA_STYLE,
  NA_DASH_STYLE,
  HOLDER_CHIP_STYLE,
  ROI_CELL_STYLE,
  PNL_CELL_STYLE,
  RIGHT_CELL_STYLE,
  STAT_TEXT_TERTIARY_STYLE,
  ROI_TEXT_BASE_STYLE,
  SUPPORTING_STAT_STYLE,
} from './TraderRowStyles'

function safeNonNegativeCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

// ── N/A Indicator ──────────────────────────────────────────────────────────

function NaIndicator({
  source,
  metricType,
}: {
  source?: string
  metricType: 'winRate' | 'drawdown'
}) {
  const platformNote = source ? getPlatformNote(source) : undefined
  const defaultNote =
    metricType === 'winRate' ? i18nT('winRateNotAvailable') : i18nT('drawdownNotAvailable')

  return (
    <span title={platformNote || defaultNote} style={NA_STYLE}>
      &mdash;
    </span>
  )
}

// ── Animated ROI ───────────────────────────────────────────────────────────

function AnimatedROI({
  roi,
  roiColor,
  animate,
}: {
  roi: number | null
  roiColor: string
  animate?: boolean
}) {
  // Keep the hook call unconditional, but never turn an absent source metric
  // into the numeric value zero for display, accessibility, or animation.
  const animatedValue = useCountUp(
    animate && roi != null ? roi : 0,
    animate && roi != null ? 500 : 0
  )
  const displayValue = animate ? animatedValue : roi
  // Colorblind-safe direction cue (audit 1.2): the +/− sign already lives in the
  // text, so the arrow is redundant reinforcement and is aria-hidden. Mirrors
  // <Metric showArrow>. Kept here (rather than swapping in Metric) to preserve
  // the count-up animation on the top-3 rows.
  const arrowGlyph = roi != null && roi > 0 ? '▲' : roi != null && roi < 0 ? '▼' : ''
  return (
    <Text
      size="md"
      weight="bold"
      className="roi-value"
      style={{ ...ROI_TEXT_BASE_STYLE, color: roiColor }}
      title={roi != null ? `${roi >= 0 ? '+' : ''}${Number(roi).toFixed(2)}%` : 'ROI unknown'}
    >
      {arrowGlyph && (
        <span aria-hidden="true" style={{ marginRight: '0.25em', fontSize: '0.8em' }}>
          {arrowGlyph}
        </span>
      )}
      {roi != null ? formatROI(displayValue) : '—'}
    </Text>
  )
}

// ── Metric Cells ───────────────────────────────────────────────────────────

export interface TraderMetricCellsProps {
  trader: Trader
  rank: number
  source?: string
  language: string
  getPnLTooltipFn: (source: string, lang: string) => string
  t: (key: string) => string
}

/**
 * All metric columns for a trader row: ROI, PnL, Win%, MDD, Sharpe, Followers, Trades.
 */
export const TraderMetricCells = memo(function TraderMetricCells({
  trader,
  rank,
  source,
  language,
  getPnLTooltipFn,
  t,
}: TraderMetricCellsProps) {
  // ROI
  const roi = trader.roi != null && Number.isFinite(trader.roi) ? trader.roi : null
  const roiColor =
    roi != null && roi > 0
      ? tokens.colors.accent.success
      : roi != null && roi < 0
        ? tokens.colors.accent.error
        : tokens.colors.text.tertiary

  // PnL
  const pnl = trader.pnl
  const hasPnl = pnl != null
  const parsedDrawdown = trader.max_drawdown == null ? null : Number(trader.max_drawdown)
  const drawdownDisplay = formatDrawdown(parsedDrawdown)
  const hasDrawdown = drawdownDisplay !== NULL_DISPLAY
  const copierCount = safeNonNegativeCount(trader.copiers ?? trader.followers)
  const tradesCount = safeNonNegativeCount(trader.trades_count)

  return (
    <>
      {/* ROI — current published scalar only; historical trajectories are quarantined. */}
      <Box className="roi-cell" style={ROI_CELL_STYLE}>
        <AnimatedROI roi={roi} roiColor={roiColor} animate={rank <= 3} />
      </Box>

      {/* PnL — shared Metric with colorblind-safe arrow (audit 1.2) */}
      <Box className="col-pnl" style={PNL_CELL_STYLE}>
        <Metric
          value={hasPnl ? pnl : null}
          format="pnl"
          size="sm"
          align="right"
          showArrow
          className="pnl-value"
          title={hasPnl ? getPnLTooltipFn(trader.source || source || '', language) : undefined}
          style={{ opacity: hasPnl ? 1 : 0.4, cursor: hasPnl ? 'help' : 'default' }}
        />
      </Box>

      {/* Win% — neutral supporting stat (owner 2026-11-13: only ROI and PnL
          carry gain/loss color; a green >50% win rate read as a second signal). */}
      <Box className="col-winrate" style={RIGHT_CELL_STYLE}>
        {trader.win_rate != null && Number.isFinite(Number(trader.win_rate)) ? (
          <Text
            size="sm"
            weight="medium"
            className="metric-neutral"
            style={{
              ...SUPPORTING_STAT_STYLE,
              opacity: trader.metrics_estimated ? 0.6 : 1,
            }}
            title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}
          >
            {trader.metrics_estimated ? '~' : ''}
            {Number(trader.win_rate).toFixed(1)}%
          </Text>
        ) : trader.trades_count === 0 ? (
          // Confirmed zero-trade wallet (explicit 0, NOT null/unknown): win% is
          // undefined by design — gains come from held positions. Labeled chip
          // instead of a dash so the row reads intentional, not broken.
          <span title={i18nT('holderTooltip')} style={HOLDER_CHIP_STYLE}>
            {i18nT('holderBadge')}
          </span>
        ) : (
          <NaIndicator source={trader.source || source} metricType="winRate" />
        )}
      </Box>

      {/* MDD — neutral supporting stat. A drawdown is always a loss by
          definition, so a permanent red ▼ carried no information (owner
          2026-11-13). formatDrawdown already renders the leading minus. */}
      <Box className="col-mdd" style={RIGHT_CELL_STYLE}>
        {hasDrawdown ? (
          <Text
            size="sm"
            weight="medium"
            className="metric-neutral"
            title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}
            style={{
              ...SUPPORTING_STAT_STYLE,
              opacity: trader.metrics_estimated ? 0.6 : 1,
            }}
          >
            {`${trader.metrics_estimated ? '~' : ''}${drawdownDisplay}`}
          </Text>
        ) : (
          <NaIndicator source={trader.source || source} metricType="drawdown" />
        )}
      </Box>

      {/* Sharpe Ratio */}
      <Box className="col-sharpe" style={RIGHT_CELL_STYLE}>
        {trader.sharpe_ratio != null && Number.isFinite(Number(trader.sharpe_ratio)) ? (
          <Text size="sm" weight="medium" style={SUPPORTING_STAT_STYLE}>
            {Number(trader.sharpe_ratio).toFixed(2)}
          </Text>
        ) : (
          <span style={NA_DASH_STYLE}>&mdash;</span>
        )}
      </Box>

      {/* Followers — exchange copier count. Prefer `copiers` (populated: 90D max
          4756); `followers` is 0 for 100% of rows so it read as a dead dash
          (audit 2026-07-03). Fall back to followers for any source that fills it. */}
      <Box className="col-followers" style={RIGHT_CELL_STYLE}>
        {copierCount != null && copierCount > 0 ? (
          <Text size="sm" weight="semibold" style={STAT_TEXT_TERTIARY_STYLE}>
            {copierCount >= 1000 ? `${(copierCount / 1000).toFixed(1)}K` : copierCount}
          </Text>
        ) : (
          <span style={NA_DASH_STYLE}>&mdash;</span>
        )}
      </Box>

      {/* Trades Count */}
      <Box className="col-trades" style={RIGHT_CELL_STYLE}>
        {tradesCount != null ? (
          <Text size="sm" weight="semibold" style={STAT_TEXT_TERTIARY_STYLE}>
            {tradesCount >= 1000 ? `${(tradesCount / 1000).toFixed(1)}K` : tradesCount}
          </Text>
        ) : (
          <span style={NA_DASH_STYLE}>&mdash;</span>
        )}
      </Box>
    </>
  )
})
