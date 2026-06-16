'use client'

/**
 * §2.5d on-chain insight blocks for the three-tab serving UI — token PnL
 * distribution, top earning tokens, and the daily-PnL calendar. Fed by the 90d
 * core extras (binance_web3 promotes them off the board; see the adapter). The
 * whole block NULL-collapses: each sub-section renders only when its data is
 * present, and the component returns null when none are — so non-onchain sources
 * (and onchain rows crawled before the extras landed) show nothing.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatMoney } from '@/lib/utils/money'
import { PnlCalendarHeatmap } from '@/app/components/trader/charts/PnlCalendarHeatmap'
import type { ServingCurrency } from '@/lib/data/serving/types'
import {
  shapeTokenDistribution,
  shapeTopTokens,
  shapePnlCalendar,
  type TokenDistBucket,
} from './onchain-insights'

// PnL% bucket ranges are numeric → locale-neutral labels (no i18n key needed).
const BUCKET_LABEL: Record<TokenDistBucket['key'], string> = {
  gt_500: '>+500%',
  p0_500: '0~+500%',
  n50_0: '-50%~0',
  lt_n50: '<-50%',
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box
      className="glass-card"
      style={{
        padding: tokens.spacing[5],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
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
}

export default function OnchainInsights({ extras, currency }: OnchainInsightsProps) {
  const { t } = useLanguage()
  const dist = shapeTokenDistribution(extras)
  const tokensTop = shapeTopTokens(extras)
  const calendar = shapePnlCalendar(extras)

  if (!dist && !tokensTop && !calendar) return null

  const distTotal = dist ? dist.reduce((s, b) => s + b.count, 0) : 0

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {dist && distTotal > 0 && (
        <Card title={t('tokenPnlDistribution')}>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {dist.map((b) => {
              const pct = distTotal > 0 ? (b.count / distTotal) * 100 : 0
              return (
                <Box
                  key={b.key}
                  style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}
                >
                  <Text size="xs" color="tertiary" style={{ width: 72, flexShrink: 0 }}>
                    {BUCKET_LABEL[b.key]}
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
