'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { t as i18nT } from '@/lib/i18n'
import { getPlatformNote } from '@/lib/constants/platform-metrics'
import { useCountUp } from '@/lib/hooks/useCountUp'
import { TRADER_TEXT_TERTIARY, TRADER_ACCENT_ERROR } from './shared/TraderDisplay'
import { formatPnL, formatROI } from './utils'
import type { Trader } from './RankingTable'
import {
  NA_STYLE,
  NA_DASH_STYLE,
  ROI_CELL_STYLE,
  PNL_CELL_STYLE,
  RIGHT_CELL_STYLE,
  STAT_TEXT_TERTIARY_STYLE,
  MDD_TEXT_BASE_STYLE,
  ROI_TEXT_BASE_STYLE,
} from './TraderRowStyles'

// ── N/A Indicator ──────────────────────────────────────────────────────────

function NaIndicator({ source, metricType }: { source?: string; metricType: 'winRate' | 'drawdown' }) {
  const platformNote = source ? getPlatformNote(source) : undefined
  const defaultNote = metricType === 'winRate'
    ? i18nT('winRateNotAvailable')
    : i18nT('drawdownNotAvailable')

  return (
    <span title={platformNote || defaultNote} style={NA_STYLE}>
      &mdash;
    </span>
  )
}

// ── Animated ROI ───────────────────────────────────────────────────────────

function AnimatedROI({ roi, roiColor, animate }: { roi: number; roiColor: string; animate?: boolean }) {
  const animatedValue = useCountUp(animate ? roi : roi, animate ? 500 : 0)
  const displayValue = animate ? animatedValue : roi
  return (
    <Text
      size="md"
      weight="black"
      className="roi-value"
      style={{ ...ROI_TEXT_BASE_STYLE, color: roiColor }}
      title={`${roi >= 0 ? '+' : ''}${Number(roi).toFixed(2)}%`}
    >
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
  const roiColor = roi > 0 ? tokens.colors.accent.success : roi < 0 ? tokens.colors.accent.error : tokens.colors.text.tertiary

  // PnL
  const pnl = trader.pnl
  const hasPnl = pnl != null
  const pnlColor = hasPnl
    ? (pnl >= 0 ? tokens.colors.accent.success : TRADER_ACCENT_ERROR)
    : TRADER_TEXT_TERTIARY
  const pnlText = hasPnl ? formatPnL(pnl) : '\u2014'

  return (
    <>
      {/* ROI */}
      <Box className="roi-cell" style={ROI_CELL_STYLE}>
        <AnimatedROI roi={roi} roiColor={roiColor} animate={rank <= 3} />
      </Box>

      {/* PnL */}
      <Box className="col-pnl" style={PNL_CELL_STYLE}>
        <Text
          size="sm"
          weight="semibold"
          className="pnl-value"
          style={{ color: pnlColor, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, opacity: hasPnl ? 0.85 : 0.5, cursor: hasPnl ? 'help' : 'default', fontVariantNumeric: 'tabular-nums' }}
          title={hasPnl ? getPnLTooltipFn(trader.source || source || '', language) : undefined}
        >
          {pnlText}
        </Text>
      </Box>

      {/* Win% */}
      <Box className="col-winrate" style={RIGHT_CELL_STYLE}>
        {trader.win_rate != null && Number.isFinite(Number(trader.win_rate)) ? (
          <Text size="sm" weight="semibold" style={{ color: Number(trader.win_rate) > 50 ? tokens.colors.accent.success : TRADER_TEXT_TERTIARY, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums', opacity: trader.metrics_estimated ? 0.5 : 1 }} title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}>
            {trader.metrics_estimated ? '~' : ''}{Number(trader.win_rate).toFixed(1)}%
          </Text>
        ) : (
          <NaIndicator source={trader.source || source} metricType="winRate" />
        )}
      </Box>

      {/* MDD */}
      <Box className="col-mdd" style={RIGHT_CELL_STYLE}>
        {trader.max_drawdown != null && Number.isFinite(Number(trader.max_drawdown)) ? (
          <Text size="sm" weight="semibold" style={{ ...MDD_TEXT_BASE_STYLE, opacity: trader.metrics_estimated ? 0.5 : 1 }} title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}>
            {trader.metrics_estimated ? '~' : ''}{Math.abs(Number(trader.max_drawdown)) < 0.05 ? '< 0.1' : `-${Math.abs(Number(trader.max_drawdown)).toFixed(1)}`}%
          </Text>
        ) : (
          <NaIndicator source={trader.source || source} metricType="drawdown" />
        )}
      </Box>

      {/* Sharpe Ratio */}
      <Box className="col-sharpe" style={RIGHT_CELL_STYLE}>
        {trader.sharpe_ratio != null && Number.isFinite(Number(trader.sharpe_ratio)) ? (
          <Text size="sm" weight="semibold" style={{ color: Number(trader.sharpe_ratio) >= 1 ? tokens.colors.accent.success : TRADER_TEXT_TERTIARY, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums' }}>
            {Number(trader.sharpe_ratio).toFixed(2)}
          </Text>
        ) : (
          <span style={NA_DASH_STYLE}>&mdash;</span>
        )}
      </Box>

      {/* Followers */}
      <Box className="col-followers" style={RIGHT_CELL_STYLE}>
        {trader.followers != null ? (
          <Text size="sm" weight="semibold" style={STAT_TEXT_TERTIARY_STYLE}>
            {Number(trader.followers) >= 1000 ? `${(Number(trader.followers) / 1000).toFixed(1)}K` : trader.followers}
          </Text>
        ) : (
          <span style={NA_DASH_STYLE}>&mdash;</span>
        )}
      </Box>

      {/* Trades Count */}
      <Box className="col-trades" style={RIGHT_CELL_STYLE}>
        {trader.trades_count != null ? (
          <Text size="sm" weight="semibold" style={STAT_TEXT_TERTIARY_STYLE}>
            {Number(trader.trades_count) >= 1000 ? `${(Number(trader.trades_count) / 1000).toFixed(1)}K` : trader.trades_count}
          </Text>
        ) : (
          <span style={NA_DASH_STYLE}>&mdash;</span>
        )}
      </Box>
    </>
  )
})
