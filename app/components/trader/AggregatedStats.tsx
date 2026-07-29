'use client'

import { useId, useState } from 'react'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getScoreColor } from '@/lib/utils/score-colors'
import {
  formatDrawdown,
  formatROI,
  formatPnL,
  normalizeDrawdownMagnitude,
  NULL_DISPLAY,
} from '@/lib/utils/format'

interface AggregatedAccount {
  platform: string
  traderKey: string
  handle: string | null
  label: string | null
  roi: number | null
  pnl: number | null
  arenaScore: number | null
  winRate?: number | null
  maxDrawdown?: number | null
  rank?: number | null
}

interface AggregatedStatsProps {
  combinedPnl: number | null
  bestRoi: { value: number; platform: string; traderKey: string } | null
  weightedScore: number | null
  accounts: AggregatedAccount[]
}

function finiteMetric(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boundedPercent(value: number): number | null {
  return value >= 0 && value <= 100 ? value : null
}

function signedMetricColor(value: number | null): string {
  if (value == null || value === 0) return tokens.colors.text.tertiary
  return value > 0 ? tokens.colors.accent.success : tokens.colors.accent.error
}

export default function AggregatedStats({
  combinedPnl,
  bestRoi,
  weightedScore,
  accounts,
}: AggregatedStatsProps) {
  const { t } = useLanguage()
  const scoreTooltipId = useId()
  const comparisonTableId = useId()
  const [scoreTooltipHovered, setScoreTooltipHovered] = useState(false)
  const [scoreTooltipFocused, setScoreTooltipFocused] = useState(false)
  const [scoreTooltipPinned, setScoreTooltipPinned] = useState(false)
  const [scoreTooltipDismissed, setScoreTooltipDismissed] = useState(false)
  const [showComparison, setShowComparison] = useState(false)
  const showScoreTooltip =
    scoreTooltipPinned || (!scoreTooltipDismissed && (scoreTooltipHovered || scoreTooltipFocused))

  const validCombinedPnl = finiteMetric(combinedPnl)
  const validBestRoi = bestRoi && finiteMetric(bestRoi.value) != null ? bestRoi : null
  const finiteWeightedScore = finiteMetric(weightedScore)
  const validWeightedScore =
    finiteWeightedScore == null ? null : boundedPercent(finiteWeightedScore)
  const combinedPnlColor = signedMetricColor(validCombinedPnl)
  const bestRoiColor = signedMetricColor(validBestRoi?.value ?? null)
  const weightedScoreColor =
    validWeightedScore == null ? tokens.colors.text.tertiary : getScoreColor(validWeightedScore)

  // Find max |pnl| for bar chart scaling
  const maxAbsPnl = Math.max(
    ...accounts.map((account) => Math.abs(finiteMetric(account.pnl) ?? 0)),
    1
  )

  return (
    <Box
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        padding: tokens.spacing[5],
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[4],
      }}
    >
      {/* Header */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke={tokens.colors.accent.primary}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="8.5" cy="7" r="4" />
          <line x1="20" y1="8" x2="20" y2="14" />
          <line x1="23" y1="11" x2="17" y2="11" />
        </svg>
        <Text size="sm" weight="bold" style={{ color: tokens.colors.text.secondary }}>
          {t('traderCombinedPerformance')}
        </Text>
        <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginLeft: 'auto' }}>
          {accounts.length} {t('traderAccountsCount')}
        </Text>
      </Box>

      {/* Stat cards row */}
      <Box
        className="agg-stats-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: tokens.spacing[3],
        }}
      >
        {/* Combined PnL */}
        <Box
          style={{
            background: `${alpha(combinedPnlColor, 3)}`,
            borderRadius: tokens.radius.lg,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            border: `1px solid ${alpha(combinedPnlColor, 13)}`,
          }}
        >
          <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 4 }}>
            {t('traderCombinedPnl')}
          </Text>
          <Text
            size="lg"
            weight="black"
            style={{
              color: combinedPnlColor,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              letterSpacing: '-0.02em',
            }}
          >
            {formatPnL(validCombinedPnl)}
          </Text>
        </Box>

        {/* Best ROI — frame follows the value's sign (success/error) so the card
            shows one signal accent instead of a purple frame fighting a green/red
            number. */}
        <Box
          style={{
            background: `${alpha(bestRoiColor, 3)}`,
            borderRadius: tokens.radius.lg,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            border: `1px solid ${alpha(bestRoiColor, 13)}`,
          }}
        >
          <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 4 }}>
            {t('traderBestRoi')}
          </Text>
          {validBestRoi ? (
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Text
                size="lg"
                weight="black"
                style={{
                  color: bestRoiColor,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                  letterSpacing: '-0.02em',
                }}
              >
                {formatROI(validBestRoi.value)}
              </Text>
              <ExchangeLogo exchange={validBestRoi.platform} size={14} />
            </Box>
          ) : (
            <Text size="lg" weight="black" style={{ color: tokens.colors.text.tertiary }}>
              {NULL_DISPLAY}
            </Text>
          )}
        </Box>

        {/* Weighted Score with tooltip */}
        <Box
          style={{
            background: `${alpha(weightedScoreColor, 3)}`,
            borderRadius: tokens.radius.lg,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            border: `1px solid ${alpha(weightedScoreColor, 13)}`,
            position: 'relative',
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
              {t('traderWeightedScore')}
            </Text>
            <button
              type="button"
              onClick={() => {
                if (scoreTooltipPinned) {
                  setScoreTooltipPinned(false)
                  setScoreTooltipDismissed(true)
                } else {
                  setScoreTooltipPinned(true)
                  setScoreTooltipDismissed(false)
                }
              }}
              onMouseEnter={() => {
                setScoreTooltipHovered(true)
                setScoreTooltipDismissed(false)
              }}
              onMouseLeave={() => {
                setScoreTooltipHovered(false)
                if (!scoreTooltipFocused) setScoreTooltipDismissed(false)
              }}
              onFocus={() => {
                setScoreTooltipFocused(true)
                setScoreTooltipDismissed(false)
              }}
              onBlur={() => {
                setScoreTooltipFocused(false)
                setScoreTooltipPinned(false)
                setScoreTooltipDismissed(scoreTooltipHovered)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setScoreTooltipPinned(false)
                  setScoreTooltipDismissed(true)
                  event.currentTarget.blur()
                }
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                color: tokens.colors.text.tertiary,
              }}
              aria-label={t('traderWeightedScore')}
              aria-expanded={showScoreTooltip}
              aria-describedby={showScoreTooltip ? scoreTooltipId : undefined}
            >
              <svg
                aria-hidden="true"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
            </button>
          </Box>
          <Text
            size="lg"
            weight="black"
            style={{
              color: weightedScoreColor,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              letterSpacing: '-0.02em',
            }}
          >
            {validWeightedScore != null ? validWeightedScore.toFixed(1) : NULL_DISPLAY}
          </Text>
          {/* Tooltip */}
          {showScoreTooltip && (
            <Box
              id={scoreTooltipId}
              role="tooltip"
              style={{
                position: 'absolute',
                bottom: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                marginBottom: 8,
                padding: '8px 12px',
                background: tokens.colors.bg.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                boxShadow: '0 4px 12px var(--color-overlay-medium)',
                zIndex: 10,
                maxWidth: 220,
                whiteSpace: 'normal',
              }}
            >
              <Text size="xs" style={{ color: tokens.colors.text.secondary, lineHeight: 1.5 }}>
                {t('traderWeightedScoreTooltip')}
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Per-exchange ROI breakdown bars */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Text size="xs" weight="medium" style={{ color: tokens.colors.text.tertiary }}>
          {t('traderPnlBreakdown')}
        </Text>
        {accounts.map((account) => {
          const pnl = finiteMetric(account.pnl)
          const barWidth =
            pnl == null || pnl === 0 ? 0 : Math.max((Math.abs(pnl) / maxAbsPnl) * 100, 2)
          const pnlColor = signedMetricColor(pnl)
          const label = account.label || EXCHANGE_NAMES[account.platform] || account.platform

          return (
            <Box
              key={`${account.platform}:${account.traderKey}`}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <ExchangeLogo exchange={account.platform} size={16} />
              <Text
                size="xs"
                style={{
                  color: tokens.colors.text.secondary,
                  width: 80,
                  flexShrink: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </Text>
              <Box
                style={{
                  flex: 1,
                  height: 6,
                  borderRadius: 3,
                  background: `${alpha(tokens.colors.text.tertiary, 6)}`,
                  overflow: 'hidden',
                }}
              >
                <Box
                  style={{
                    height: '100%',
                    width: `${barWidth}%`,
                    borderRadius: 3,
                    background:
                      pnl == null || pnl === 0
                        ? pnlColor
                        : `linear-gradient(90deg, ${alpha(pnlColor, 50)}, ${pnlColor})`,
                    transition: 'width 0.5s ease',
                  }}
                />
              </Box>
              <Text
                size="xs"
                weight="bold"
                style={{
                  color: pnlColor,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                  width: 65,
                  textAlign: 'right',
                  flexShrink: 0,
                }}
              >
                {formatPnL(pnl)}
              </Text>
            </Box>
          )
        })}
      </Box>

      {/* Compare Accounts button */}
      {accounts.length >= 2 && (
        <button
          type="button"
          onClick={() => setShowComparison(!showComparison)}
          aria-expanded={showComparison}
          aria-controls={comparisonTableId}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '8px 16px',
            borderRadius: tokens.radius.md,
            background: showComparison
              ? `${alpha(tokens.colors.accent.primary, 8)}`
              : 'transparent',
            border: `1px solid ${showComparison ? colorAlpha(tokens.colors.accent.primary, 25) : tokens.colors.border.primary}`,
            cursor: 'pointer',
            transition: 'all 0.2s',
            color: tokens.colors.accent.primary,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          {t('traderCompareAccounts')}
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: showComparison ? 'rotate(180deg)' : undefined,
              transition: 'transform 0.2s',
            }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

      {/* Comparison table */}
      {showComparison && accounts.length >= 2 && (
        <Box
          id={comparisonTableId}
          className="comparison-table-scroll"
          style={{
            overflowX: 'auto',
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
              minWidth: accounts.length > 2 ? 500 : undefined,
            }}
          >
            <caption className="sr-only">{t('traderCompareAccounts')}</caption>
            <thead>
              <tr style={{ background: tokens.colors.bg.tertiary }}>
                <th
                  style={{
                    padding: '8px 12px',
                    textAlign: 'left',
                    color: tokens.colors.text.tertiary,
                    fontWeight: 500,
                    fontSize: 12,
                  }}
                >
                  {t('traderMetric')}
                </th>
                {accounts.map((acc) => (
                  <th
                    key={`${acc.platform}:${acc.traderKey}`}
                    style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}
                  >
                    <Box
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: 4,
                      }}
                    >
                      <ExchangeLogo exchange={acc.platform} size={14} />
                      <Text size="xs" weight="bold" style={{ color: tokens.colors.text.primary }}>
                        {acc.label || EXCHANGE_NAMES[acc.platform] || acc.platform}
                      </Text>
                      {acc.isPrimary && (
                        <span style={{ color: tokens.colors.accent.warning, fontSize: 10 }}>★</span>
                      )}
                    </Box>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* ROI */}
              <ComparisonRow
                label="ROI"
                accounts={accounts}
                getValue={(a) => a.roi}
                format={(v) => formatROI(v)}
                higherIsBetter
                bestLabel={t('compareBestValue')}
              />
              {/* PnL */}
              <ComparisonRow
                label="PnL"
                accounts={accounts}
                getValue={(a) => a.pnl}
                format={(v) => formatPnL(v)}
                higherIsBetter
                bestLabel={t('compareBestValue')}
              />
              {/* Arena Score */}
              <ComparisonRow
                label="Arena Score"
                accounts={accounts}
                getValue={(a) => a.arenaScore}
                format={(v) => v.toFixed(0)}
                higherIsBetter
                normalizeValue={boundedPercent}
                valueColor={getScoreColor}
                bestLabel={t('compareBestValue')}
              />
              {/* Win Rate */}
              <ComparisonRow
                label={t('winRate')}
                accounts={accounts}
                getValue={(a) => a.winRate ?? null}
                format={(v) => `${v.toFixed(1)}%`}
                higherIsBetter
                normalizeValue={boundedPercent}
                valueColor={() => tokens.colors.text.primary}
                bestLabel={t('compareBestValue')}
              />
              {/* Max Drawdown */}
              <ComparisonRow
                label={t('maxDrawdown')}
                accounts={accounts}
                getValue={(a) => a.maxDrawdown ?? null}
                format={formatDrawdown}
                higherIsBetter={false}
                normalizeValue={normalizeDrawdownMagnitude}
                valueColor={(value) =>
                  value === 0 ? tokens.colors.text.tertiary : tokens.colors.accent.error
                }
                bestLabel={t('compareBestValue')}
              />
            </tbody>
          </table>
          <style>{`.comparison-table-scroll::-webkit-scrollbar { display: none; }`}</style>
        </Box>
      )}

      <style>{`
        @media (max-width: 640px) {
          .agg-stats-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </Box>
  )
}

/** Comparison table row with best-value highlight */
function ComparisonRow({
  label,
  accounts,
  getValue,
  format,
  higherIsBetter,
  normalizeValue,
  valueColor,
  bestLabel,
}: {
  label: string
  accounts: AggregatedAccount[]
  getValue: (a: AggregatedAccount) => number | null | undefined
  format: (v: number) => string
  higherIsBetter: boolean
  normalizeValue?: (v: number) => number | null
  valueColor?: (v: number) => string
  bestLabel: string
}) {
  const values = accounts.map((account) => {
    const rawValue = finiteMetric(getValue(account))
    if (rawValue == null) return null
    return normalizeValue ? normalizeValue(rawValue) : rawValue
  })
  const validValues = values.filter((value): value is number => value !== null)
  const bestValue =
    validValues.length > 0
      ? higherIsBetter
        ? Math.max(...validValues)
        : Math.min(...validValues)
      : null
  const hasUniqueBest =
    bestValue != null && validValues.filter((value) => value === bestValue).length === 1

  return (
    <tr style={{ borderTop: `1px solid ${alpha(tokens.colors.border.primary, 25)}` }}>
      <td style={{ padding: '8px 12px', color: tokens.colors.text.tertiary, fontSize: 12 }}>
        {label}
      </td>
      {values.map((value, index) => {
        const account = accounts[index]
        const isBest =
          value !== null &&
          bestValue !== null &&
          value === bestValue &&
          validValues.length > 1 &&
          hasUniqueBest
        const color =
          value === null
            ? tokens.colors.text.tertiary
            : valueColor?.(value) || signedMetricColor(value)
        return (
          <td
            key={`${account.platform}:${account.traderKey}`}
            style={{
              padding: '8px 12px',
              textAlign: 'right',
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              fontWeight: isBest ? 700 : 500,
              color,
              fontSize: 13,
              background: isBest ? `${alpha(tokens.colors.accent.primary, 6)}` : undefined,
            }}
          >
            {value !== null ? format(value) : NULL_DISPLAY}
            {isBest && <span className="sr-only"> {bestLabel}</span>}
          </td>
        )
      })}
    </tr>
  )
}

interface AggregatedAccount {
  platform: string
  traderKey: string
  handle: string | null
  label: string | null
  roi: number | null
  pnl: number | null
  arenaScore: number | null
  winRate?: number | null
  maxDrawdown?: number | null
  rank?: number | null
  isPrimary?: boolean
}
