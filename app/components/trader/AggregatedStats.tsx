'use client'

import { useId, useState } from 'react'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  formatDrawdown,
  formatROI,
  normalizeDrawdownMagnitude,
  NULL_DISPLAY,
} from '@/lib/utils/format'
import { linkedAccountDisplayLabel } from './linked-account-view'

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

interface AggregatedStatsProps {
  /** Closed until a common Money/cost-basis publication contract exists. */
  combinedPnl: null
  /** Closed until every account has complete, comparable ROI evidence. */
  bestRoi: null
  /** Closed until every account has a comparable score and weighting proof. */
  weightedScore: null
  accounts: AggregatedAccount[]
}

function finiteMetric(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boundedPercent(value: number): number | null {
  return value >= 0 && value <= 100 ? value : null
}

function boundedRoi(value: number): number | null {
  return value >= -10_000 && value <= 10_000 ? value : null
}

function signedMetricColor(value: number | null): string {
  if (value == null || value === 0) return tokens.colors.text.tertiary
  return value > 0 ? tokens.colors.accent.success : tokens.colors.accent.error
}

export default function AggregatedStats({ accounts }: AggregatedStatsProps) {
  const { t } = useLanguage()
  const comparisonTableId = useId()
  const [showComparison, setShowComparison] = useState(false)
  const hasAccountMetricEvidence = accounts.some((account) => {
    const roi = finiteMetric(account.roi)
    const winRate = finiteMetric(account.winRate)
    const drawdown = finiteMetric(account.maxDrawdown)
    return (
      (roi !== null && boundedRoi(roi) !== null) ||
      (winRate !== null && boundedPercent(winRate) !== null) ||
      (drawdown !== null && normalizeDrawdownMagnitude(drawdown) !== null)
    )
  })

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
          {t('traderLinkedAccountEvidence')}
        </Text>
        <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginLeft: 'auto' }}>
          {accounts.length} {t('traderAccountsCount')}
        </Text>
      </Box>

      <Box
        role="note"
        style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          border: `1px solid ${alpha(tokens.colors.text.tertiary, 13)}`,
          background: alpha(tokens.colors.text.tertiary, 3),
        }}
      >
        <Text size="xs" style={{ color: tokens.colors.text.tertiary, lineHeight: 1.5 }}>
          {t('traderAggregateUnavailable')}
        </Text>
      </Box>

      {hasAccountMetricEvidence && (
        <Box
          role="note"
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${alpha(tokens.colors.accent.warning, 19)}`,
            background: alpha(tokens.colors.accent.warning, 4),
          }}
        >
          <Text size="xs" style={{ color: tokens.colors.text.tertiary, lineHeight: 1.5 }}>
            {t('traderAccountMetricsPartial')}
          </Text>
        </Box>
      )}

      {/* Compare Accounts button */}
      {accounts.length >= 2 && hasAccountMetricEvidence && (
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
      {showComparison && accounts.length >= 2 && hasAccountMetricEvidence && (
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
                        {linkedAccountDisplayLabel(acc, accounts)}
                      </Text>
                      {acc.isPrimary && (
                        <span
                          aria-label={t('traderPrimaryAccount')}
                          style={{ color: tokens.colors.accent.warning, fontSize: 10 }}
                        >
                          <span aria-hidden="true">★</span>
                        </span>
                      )}
                    </Box>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* ROI */}
              <ComparisonRow
                label="ROI · 90D"
                accounts={accounts}
                getValue={(a) => a.roi}
                format={(v) => formatROI(v)}
                normalizeValue={boundedRoi}
              />
              {/* Win Rate */}
              <ComparisonRow
                label={`${t('winRate')} · 90D`}
                accounts={accounts}
                getValue={(a) => a.winRate ?? null}
                format={(v) => `${v.toFixed(1)}%`}
                normalizeValue={boundedPercent}
                valueColor={() => tokens.colors.text.primary}
              />
              {/* Max Drawdown */}
              <ComparisonRow
                label={`${t('maxDrawdown')} · 90D`}
                accounts={accounts}
                getValue={(a) => a.maxDrawdown ?? null}
                format={formatDrawdown}
                normalizeValue={normalizeDrawdownMagnitude}
                valueColor={(value) =>
                  value === 0 ? tokens.colors.text.tertiary : tokens.colors.accent.error
                }
              />
            </tbody>
          </table>
          <style>{`.comparison-table-scroll::-webkit-scrollbar { display: none; }`}</style>
        </Box>
      )}
    </Box>
  )
}

/** Comparison table row. Values are informational; no cross-source "best" claim. */
function ComparisonRow({
  label,
  accounts,
  getValue,
  format,
  normalizeValue,
  valueColor,
}: {
  label: string
  accounts: AggregatedAccount[]
  getValue: (a: AggregatedAccount) => number | null | undefined
  format: (v: number) => string
  normalizeValue?: (v: number) => number | null
  valueColor?: (v: number) => string
}) {
  const values = accounts.map((account) => {
    const rawValue = finiteMetric(getValue(account))
    if (rawValue == null) return null
    return normalizeValue ? normalizeValue(rawValue) : rawValue
  })
  if (!values.some((value) => value !== null)) return null

  return (
    <tr style={{ borderTop: `1px solid ${alpha(tokens.colors.border.primary, 25)}` }}>
      <td style={{ padding: '8px 12px', color: tokens.colors.text.tertiary, fontSize: 12 }}>
        {label}
      </td>
      {values.map((value, index) => {
        const account = accounts[index]
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
              fontWeight: 500,
              color,
              fontSize: 13,
            }}
          >
            {value !== null ? format(value) : NULL_DISPLAY}
          </td>
        )
      })}
    </tr>
  )
}
