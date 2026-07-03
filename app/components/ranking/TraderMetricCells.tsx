'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { t as i18nT } from '@/lib/i18n'
import { getPlatformNote } from '@/lib/constants/platform-metrics'
import { useCountUp } from '@/lib/hooks/useCountUp'
import { TRADER_TEXT_TERTIARY } from './shared/TraderDisplay'
import { formatROI } from './utils'
import Metric from '../ui/Metric'
import type { Trader } from './RankingTable'
import {
  NA_STYLE,
  NA_DASH_STYLE,
  ROI_CELL_STYLE,
  PNL_CELL_STYLE,
  RIGHT_CELL_STYLE,
  STAT_TEXT_TERTIARY_STYLE,
  ROI_TEXT_BASE_STYLE,
} from './TraderRowStyles'

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
  roi: number
  roiColor: string
  animate?: boolean
}) {
  const animatedValue = useCountUp(animate ? roi : roi, animate ? 500 : 0)
  const displayValue = animate ? animatedValue : roi
  // Colorblind-safe direction cue (audit 1.2): the +/− sign already lives in the
  // text, so the arrow is redundant reinforcement and is aria-hidden. Mirrors
  // <Metric showArrow>. Kept here (rather than swapping in Metric) to preserve
  // the count-up animation on the top-3 rows.
  const arrowGlyph = roi > 0 ? '▲' : roi < 0 ? '▼' : ''
  return (
    <Text
      size="md"
      weight="black"
      className="roi-value"
      style={{ ...ROI_TEXT_BASE_STYLE, color: roiColor }}
      title={`${roi >= 0 ? '+' : ''}${Number(roi).toFixed(2)}%`}
    >
      {arrowGlyph && (
        <span aria-hidden="true" style={{ marginRight: '0.25em', fontSize: '0.8em' }}>
          {arrowGlyph}
        </span>
      )}
      {formatROI(displayValue)}
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
  const roi = trader.roi ?? 0
  const roiColor =
    roi > 0
      ? tokens.colors.accent.success
      : roi < 0
        ? tokens.colors.accent.error
        : tokens.colors.text.tertiary

  // PnL
  const pnl = trader.pnl
  const hasPnl = pnl != null

  return (
    <>
      {/* ROI */}
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
          style={{ opacity: hasPnl ? 0.7 : 0.4, cursor: hasPnl ? 'help' : 'default' }}
        />
      </Box>

      {/* Win% */}
      <Box className="col-winrate" style={RIGHT_CELL_STYLE}>
        {trader.win_rate != null && Number.isFinite(Number(trader.win_rate)) ? (
          <Text
            size="sm"
            weight="medium"
            style={{
              color:
                Number(trader.win_rate) > 50 ? tokens.colors.accent.success : TRADER_TEXT_TERTIARY,
              lineHeight: 1.2,
              fontSize: tokens.typography.fontSize.sm,
              fontVariantNumeric: 'tabular-nums',
              opacity: trader.metrics_estimated ? 0.4 : 0.75,
            }}
            title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}
          >
            {trader.metrics_estimated ? '~' : ''}
            {Number(trader.win_rate).toFixed(1)}%
          </Text>
        ) : (
          <NaIndicator source={trader.source || source} metricType="winRate" />
        )}
      </Box>

      {/* MDD — shared Metric, rendered as a negative loss with arrow (audit 1.2).
          Pre-formatted via `display` because the values are already in percent
          units (Metric's `percent` formatter would multiply by 100). */}
      <Box className="col-mdd" style={RIGHT_CELL_STYLE}>
        {trader.max_drawdown != null && Number.isFinite(Number(trader.max_drawdown)) ? (
          <Metric
            value={-Math.abs(Number(trader.max_drawdown))}
            format="percent"
            display={`${trader.metrics_estimated ? '~' : ''}${
              Math.abs(Number(trader.max_drawdown)) < 0.05
                ? '< 0.1%'
                : `-${Math.abs(Number(trader.max_drawdown)).toFixed(1)}%`
            }`}
            size="sm"
            align="right"
            showArrow
            title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}
            style={{ opacity: trader.metrics_estimated ? 0.4 : 0.7 }}
          />
        ) : (
          <NaIndicator source={trader.source || source} metricType="drawdown" />
        )}
      </Box>

      {/* Sharpe Ratio */}
      <Box className="col-sharpe" style={RIGHT_CELL_STYLE}>
        {trader.sharpe_ratio != null && Number.isFinite(Number(trader.sharpe_ratio)) ? (
          <Text
            size="sm"
            weight="medium"
            style={{
              color:
                Number(trader.sharpe_ratio) >= 1
                  ? tokens.colors.accent.success
                  : TRADER_TEXT_TERTIARY,
              lineHeight: 1.2,
              fontSize: tokens.typography.fontSize.sm,
              fontVariantNumeric: 'tabular-nums',
              opacity: 0.75,
            }}
          >
            {Number(trader.sharpe_ratio).toFixed(2)}
          </Text>
        ) : (
          <span style={NA_DASH_STYLE}>&mdash;</span>
        )}
      </Box>

      {/* Followers — exchange copier count. Prefer `copiers` (populated: 90D max
          4756); `followers` is 0 for 100% of rows so it read as a dead dash
          (audit 2026-07-03). Fall back to followers for any source that fills it. */}
      {(() => {
        const copierN = Number(trader.copiers ?? trader.followers ?? 0)
        return (
          <Box className="col-followers" style={RIGHT_CELL_STYLE}>
            {copierN > 0 ? (
              <Text size="sm" weight="semibold" style={STAT_TEXT_TERTIARY_STYLE}>
                {copierN >= 1000 ? `${(copierN / 1000).toFixed(1)}K` : copierN}
              </Text>
            ) : (
              <span style={NA_DASH_STYLE}>&mdash;</span>
            )}
          </Box>
        )
      })()}

      {/* Trades Count */}
      <Box className="col-trades" style={RIGHT_CELL_STYLE}>
        {trader.trades_count != null ? (
          <Text size="sm" weight="semibold" style={STAT_TEXT_TERTIARY_STYLE}>
            {Number(trader.trades_count) >= 1000
              ? `${(Number(trader.trades_count) / 1000).toFixed(1)}K`
              : trader.trades_count}
          </Text>
        ) : (
          <span style={NA_DASH_STYLE}>&mdash;</span>
        )}
      </Box>
    </>
  )
})
