'use client'

/**
 * §2.5d on-chain insight blocks for the three-tab serving UI — token PnL
 * distribution, top earning tokens, and the daily-PnL calendar. Fed by the 90d
 * core extras (binance_web3 promotes them off the board; see the adapter). The
 * whole block NULL-collapses: each sub-section renders only when its data is
 * present, and the component returns null when none are — so non-onchain sources
 * (and onchain rows crawled before the extras landed) show nothing.
 */

import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatMoney } from '@/lib/utils/money'
import { PnlCalendarHeatmap } from '@/app/components/trader/charts/PnlCalendarHeatmap'
import type { ServingCurrency } from '@/lib/data/serving/types'
import type { OnchainEnrichmentState } from '@/app/(app)/trader/[handle]/hooks/useOnchainEnrichTrigger'
import {
  shapeTokenDistribution,
  shapeTopTokens,
  shapePnlCalendar,
  shapeOnchainPnl,
  shapeOnchainQuality,
  type TokenDistBucket,
  type TokenDistributionUnit,
} from './onchain-insights'

// Both range systems are numeric → locale-neutral labels (no i18n key needed).
const BUCKET_LABEL: Record<TokenDistributionUnit, Record<TokenDistBucket['key'], string>> = {
  pnl_percent: {
    gt_500: '>+500%',
    p0_500: '0~+500%',
    n50_0: '-50%~0',
    lt_n50: '<-50%',
  },
  realized_pnl_usd: {
    gt_500: '>+$500',
    p0_500: '$0~+$500',
    n50_0: '-$50~$0',
    lt_n50: '<-$50',
  },
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box
      className="glass-card"
      style={{
        padding: tokens.spacing[5],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${alpha(tokens.colors.border.primary, 38)}`,
      }}
    >
      <Text
        size="sm"
        weight="bold"
        style={{ color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[3] }}
      >
        {title}
      </Text>
      {children}
    </Box>
  )
}

export interface OnchainInsightsProps {
  extras: Record<string, unknown>
  currency: ServingCurrency
  enrichmentState?: OnchainEnrichmentState
}

export default function OnchainInsights({
  extras,
  currency,
  enrichmentState = 'idle',
}: OnchainInsightsProps) {
  const { t } = useLanguage()
  const dist = shapeTokenDistribution(extras)
  const tokensTop = shapeTopTokens(extras)
  const calendar = shapePnlCalendar(extras)
  const pnl = shapeOnchainPnl(extras)
  const quality = shapeOnchainQuality(extras)
  const enrichmentUnavailable = enrichmentState === 'unavailable' || enrichmentState === 'failed'

  if (!dist && !tokensTop && !calendar && !pnl && !enrichmentUnavailable) return null

  const distTotal = dist ? dist.buckets.reduce((sum, bucket) => sum + bucket.count, 0) : 0

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {enrichmentUnavailable && (
        <Box
          role="status"
          aria-label={t('onchainEstimatedData')}
          style={{
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.lg,
            background: alpha(tokens.colors.accent.warning, 8),
            border: `1px dashed ${alpha(tokens.colors.accent.warning, 30)}`,
          }}
        >
          <Text size="sm" weight="semibold" style={{ color: tokens.colors.accent.warning }}>
            {t('onchainEstimatedData')} · {t('serviceTemporarilyUnavailable')}
          </Text>
        </Box>
      )}

      {quality && !quality.canonical && (
        <Box
          role="note"
          aria-label={t('onchainEstimatedData')}
          style={{
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.lg,
            background: alpha(tokens.colors.accent.warning, 8),
            border: `1px solid ${alpha(tokens.colors.accent.warning, 24)}`,
          }}
        >
          <Text
            size="sm"
            weight="bold"
            style={{ display: 'block', color: tokens.colors.accent.warning }}
          >
            {t('onchainEstimatedData')}
          </Text>
          <Text
            size="xs"
            color="tertiary"
            style={{ display: 'block', marginTop: tokens.spacing[1], lineHeight: 1.5 }}
          >
            {t('onchainEstimatedDataHint')}
          </Text>
        </Box>
      )}

      {pnl && (
        <Card title={quality?.canonical ? t('metricTotalPnl') : t('estimatedPnl')}>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: tokens.spacing[3],
            }}
          >
            {[
              { label: 'metricTotalPnl', value: pnl.total },
              { label: 'metricRealizedPnl', value: pnl.realized },
              { label: 'metricUnrealizedPnl', value: pnl.unrealized },
            ]
              .filter((row): row is { label: string; value: number } => row.value !== null)
              .map((row) => (
                <Box key={row.label}>
                  <Text size="xs" color="tertiary" style={{ display: 'block' }}>
                    {t(row.label)}
                  </Text>
                  <Text
                    size="md"
                    weight="bold"
                    style={{
                      display: 'block',
                      marginTop: tokens.spacing[1],
                      color:
                        row.value >= 0
                          ? 'var(--color-accent-success)'
                          : 'var(--color-accent-error)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatMoney({ value: row.value, currency }, { compact: true, signed: true })}
                  </Text>
                </Box>
              ))}
          </Box>
        </Card>
      )}

      {dist && distTotal > 0 && (
        <Card title={t('tokenPnlDistribution')}>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {dist.buckets.map((b) => {
              const pct = distTotal > 0 ? (b.count / distTotal) * 100 : 0
              return (
                <Box
                  key={b.key}
                  style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}
                >
                  <Text size="xs" color="tertiary" style={{ width: 72, flexShrink: 0 }}>
                    {BUCKET_LABEL[dist.unit][b.key]}
                  </Text>
                  <Box
                    style={{
                      flex: 1,
                      height: 8,
                      borderRadius: tokens.radius.full,
                      background: 'var(--color-bg-tertiary)',
                      overflow: 'hidden',
                    }}
                  >
                    <Box
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: b.positive
                          ? 'var(--color-accent-success)'
                          : 'var(--color-accent-error)',
                      }}
                    />
                  </Box>
                  <Text
                    size="xs"
                    weight="semibold"
                    color="primary"
                    style={{ width: 32, textAlign: 'right', flexShrink: 0 }}
                  >
                    {b.count}
                  </Text>
                </Box>
              )
            })}
          </Box>
        </Card>
      )}

      {tokensTop && (
        <Card title={t('topEarningTokens')}>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {tokensTop.map((tk, i) => (
              <Box
                key={`${tk.address}-${i}`}
                style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}
              >
                <Text size="sm" weight="semibold" color="primary" style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'block',
                    }}
                  >
                    {tk.symbol}
                  </span>
                </Text>
                {tk.profitPct != null && (
                  <Text
                    size="xs"
                    color="tertiary"
                    style={{ width: 80, textAlign: 'right', flexShrink: 0 }}
                  >
                    {tk.profitPct >= 0 ? '+' : ''}
                    {tk.profitPct.toFixed(1)}%
                  </Text>
                )}
                {tk.realizedPnl != null && (
                  <Text
                    size="sm"
                    weight="semibold"
                    style={{
                      width: 92,
                      textAlign: 'right',
                      flexShrink: 0,
                      color:
                        tk.realizedPnl >= 0
                          ? 'var(--color-accent-success)'
                          : 'var(--color-accent-error)',
                    }}
                  >
                    {formatMoney({ value: tk.realizedPnl, currency }, { compact: true })}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        </Card>
      )}

      {calendar && (
        <Card title={t('dailyPnlHeatmap')}>
          <PnlCalendarHeatmap data={calendar} days={90} />
        </Card>
      )}
    </Box>
  )
}
