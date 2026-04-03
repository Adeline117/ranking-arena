'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getScoreColor } from '@/lib/utils/score-colors'
import { formatROI, formatPnL } from '@/lib/utils/format'

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
  combinedPnl: number
  bestRoi: { value: number; platform: string; traderKey: string } | null
  weightedScore: number
  accounts: AggregatedAccount[]
}

export default function AggregatedStats({
  combinedPnl,
  bestRoi,
  weightedScore,
  accounts,
}: AggregatedStatsProps) {
  const { t } = useLanguage()
  const [showScoreTooltip, setShowScoreTooltip] = useState(false)
  const [showComparison, setShowComparison] = useState(false)

  // Find max |pnl| for bar chart scaling
  const maxAbsPnl = Math.max(...accounts.map((a) => Math.abs(a.pnl ?? 0)), 1)

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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            background: `${combinedPnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error}08`,
            borderRadius: tokens.radius.lg,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            border: `1px solid ${combinedPnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error}20`,
          }}
        >
          <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 4 }}>
            {t('traderCombinedPnl')}
          </Text>
          <Text
            size="lg"
            weight="black"
            style={{
              color: combinedPnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              letterSpacing: '-0.02em',
            }}
          >
            {formatPnL(combinedPnl)}
          </Text>
        </Box>

        {/* Best ROI */}
        <Box
          style={{
            background: `${tokens.colors.accent.primary}08`,
            borderRadius: tokens.radius.lg,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            border: `1px solid ${tokens.colors.accent.primary}20`,
          }}
        >
          <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 4 }}>
            {t('traderBestRoi')}
          </Text>
          {bestRoi ? (
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Text
                size="lg"
                weight="black"
                style={{
                  color: bestRoi.value >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                  letterSpacing: '-0.02em',
                }}
              >
                {formatROI(bestRoi.value)}
              </Text>
              <ExchangeLogo exchange={bestRoi.platform} size={14} />
            </Box>
          ) : (
            <Text size="lg" weight="black" style={{ color: tokens.colors.text.tertiary }}>--</Text>
          )}
        </Box>

        {/* Weighted Score with tooltip */}
        <Box
          style={{
            background: `${getScoreColor(weightedScore)}08`,
            borderRadius: tokens.radius.lg,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            border: `1px solid ${getScoreColor(weightedScore)}20`,
            position: 'relative',
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
              {t('traderWeightedScore')}
            </Text>
            <button
              onClick={() => setShowScoreTooltip(!showScoreTooltip)}
              onMouseEnter={() => setShowScoreTooltip(true)}
              onMouseLeave={() => setShowScoreTooltip(false)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                display: 'inline-flex', alignItems: 'center', color: tokens.colors.text.tertiary,
              }}
              aria-label="Score info"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              color: getScoreColor(weightedScore),
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              letterSpacing: '-0.02em',
            }}
          >
            {weightedScore != null ? weightedScore.toFixed(1) : '—'}
          </Text>
          {/* Tooltip */}
          {showScoreTooltip && (
            <Box
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
          const pnl = account.pnl ?? 0
          const barWidth = Math.max((Math.abs(pnl) / maxAbsPnl) * 100, 2)
          const isPositive = pnl >= 0
          const label = account.label || EXCHANGE_NAMES[account.platform] || account.platform

          return (
            <Box
              key={`${account.platform}:${account.traderKey}`}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <ExchangeLogo exchange={account.platform} size={16} />
              <Text size="xs" style={{ color: tokens.colors.text.secondary, width: 80, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
              </Text>
              <Box style={{ flex: 1, height: 6, borderRadius: 3, background: `${tokens.colors.text.tertiary}10`, overflow: 'hidden' }}>
                <Box
                  style={{
                    height: '100%',
                    width: `${barWidth}%`,
                    borderRadius: 3,
                    background: isPositive
                      ? `linear-gradient(90deg, ${tokens.colors.accent.success}80, ${tokens.colors.accent.success})`
                      : `linear-gradient(90deg, ${tokens.colors.accent.error}80, ${tokens.colors.accent.error})`,
                    transition: 'width 0.5s ease',
                  }}
                />
              </Box>
              <Text
                size="xs"
                weight="bold"
                style={{
                  color: isPositive ? tokens.colors.accent.success : tokens.colors.accent.error,
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
          onClick={() => setShowComparison(!showComparison)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '8px 16px', borderRadius: tokens.radius.md,
            background: showComparison ? `${tokens.colors.accent.primary}15` : 'transparent',
            border: `1px solid ${showComparison ? tokens.colors.accent.primary + '40' : tokens.colors.border.primary}`,
            cursor: 'pointer', transition: 'all 0.2s',
            color: tokens.colors.accent.primary, fontSize: 13, fontWeight: 600,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          {t('traderCompareAccounts')}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showComparison ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

      {/* Comparison table */}
      {showComparison && accounts.length >= 2 && (
        <Box
          className="comparison-table-scroll"
          style={{
            overflowX: 'auto',
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: accounts.length > 2 ? 500 : undefined }}>
            <thead>
              <tr style={{ background: tokens.colors.bg.tertiary }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', color: tokens.colors.text.tertiary, fontWeight: 500, fontSize: 12 }}>
                  {t('traderMetric') || 'Metric'}
                </th>
                {accounts.map(acc => (
                  <th key={`${acc.platform}:${acc.traderKey}`} style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                      <ExchangeLogo exchange={acc.platform} size={14} />
                      <Text size="xs" weight="bold" style={{ color: tokens.colors.text.primary }}>
                        {acc.label || EXCHANGE_NAMES[acc.platform] || acc.platform}
                      </Text>
                      {acc.isPrimary && <span style={{ color: tokens.colors.accent.warning, fontSize: 10 }}>★</span>}
                    </Box>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* ROI */}
              <ComparisonRow label="ROI" accounts={accounts} getValue={a => a.roi} format={v => formatROI(v)} higherIsBetter />
              {/* PnL */}
              <ComparisonRow label="PnL" accounts={accounts} getValue={a => a.pnl} format={v => formatPnL(v)} higherIsBetter />
              {/* Arena Score */}
              <ComparisonRow label="Arena Score" accounts={accounts} getValue={a => a.arenaScore} format={v => v.toFixed(0)} higherIsBetter />
              {/* Win Rate */}
              <ComparisonRow label={t('winRate') || 'Win Rate'} accounts={accounts} getValue={a => a.winRate ?? null} format={v => `${v.toFixed(1)}%`} higherIsBetter />
              {/* Max Drawdown */}
              <ComparisonRow label={t('maxDrawdown') || 'Max DD'} accounts={accounts} getValue={a => a.maxDrawdown ?? null} format={v => `${v.toFixed(1)}%`} higherIsBetter={false} />
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
}: {
  label: string
  accounts: AggregatedAccount[]
  getValue: (a: AggregatedAccount) => number | null | undefined
  format: (v: number) => string
  higherIsBetter: boolean
}) {
  const values = accounts.map(a => getValue(a) ?? null)
  const validValues = values.filter((v): v is number => v !== null)
  const bestValue = validValues.length > 0
    ? (higherIsBetter ? Math.max(...validValues) : Math.min(...validValues))
    : null

  return (
    <tr style={{ borderTop: `1px solid ${tokens.colors.border.primary}40` }}>
      <td style={{ padding: '8px 12px', color: tokens.colors.text.tertiary, fontSize: 12 }}>{label}</td>
      {values.map((v, i) => {
        const isBest = v !== null && bestValue !== null && v === bestValue && validValues.length > 1
        const color = v === null
          ? tokens.colors.text.tertiary
          : v >= 0
            ? tokens.colors.accent.success
            : tokens.colors.accent.error
        return (
          <td
            key={i}
            style={{
              padding: '8px 12px',
              textAlign: 'right',
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              fontWeight: isBest ? 700 : 500,
              color: isBest ? tokens.colors.accent.success : color,
              fontSize: 13,
              background: isBest ? `${tokens.colors.accent.success}08` : undefined,
            }}
          >
            {v !== null ? format(v) : '—'}
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
