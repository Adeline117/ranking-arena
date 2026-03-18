'use client'

import { tokens } from '@/lib/design-tokens'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getScoreColor } from '@/lib/utils/score-colors'

interface AggregatedAccount {
  platform: string
  traderKey: string
  handle: string | null
  label: string | null
  roi: number | null
  pnl: number | null
  arenaScore: number | null
}

interface AggregatedStatsProps {
  combinedPnl: number
  bestRoi: { value: number; platform: string; traderKey: string } | null
  weightedScore: number
  accounts: AggregatedAccount[]
}

function formatPnl(pnl: number): string {
  const abs = Math.abs(pnl)
  const sign = pnl >= 0 ? '+' : '-'
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function formatRoi(roi: number): string {
  const sign = roi >= 0 ? '+' : ''
  return `${sign}${roi.toFixed(1)}%`
}

/**
 * AggregatedStats — shows combined stats across all linked accounts.
 * Only rendered when user has 2+ linked accounts.
 */
export default function AggregatedStats({
  combinedPnl,
  bestRoi,
  weightedScore,
  accounts,
}: AggregatedStatsProps) {
  const { t } = useLanguage()

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
            {formatPnl(combinedPnl)}
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
                {formatRoi(bestRoi.value)}
              </Text>
              <ExchangeLogo exchange={bestRoi.platform} size={14} />
            </Box>
          ) : (
            <Text size="lg" weight="black" style={{ color: tokens.colors.text.tertiary }}>--</Text>
          )}
        </Box>

        {/* Weighted Score */}
        <Box
          style={{
            background: `${getScoreColor(weightedScore)}08`,
            borderRadius: tokens.radius.lg,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            border: `1px solid ${getScoreColor(weightedScore)}20`,
          }}
        >
          <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 4 }}>
            {t('traderWeightedScore')}
          </Text>
          <Text
            size="lg"
            weight="black"
            style={{
              color: getScoreColor(weightedScore),
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              letterSpacing: '-0.02em',
            }}
          >
            {weightedScore > 0 ? weightedScore.toFixed(1) : '--'}
          </Text>
        </Box>
      </Box>

      {/* Per-exchange ROI breakdown bars */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Text size="xs" weight="medium" style={{ color: tokens.colors.text.tertiary }}>
          {t('traderPnlBreakdown')}
        </Text>
        {accounts.map((account) => {
          const pnl = account.pnl ?? 0
          const barWidth = Math.max((Math.abs(pnl) / maxAbsPnl) * 100, 2) // min 2% for visibility
          const isPositive = pnl >= 0
          const label = account.label || EXCHANGE_NAMES[account.platform] || account.platform

          return (
            <Box
              key={`${account.platform}:${account.traderKey}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
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
                {formatPnl(pnl)}
              </Text>
            </Box>
          )
        })}
      </Box>

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
