'use client'

/**
 * Copier tab — AGGREGATE ONLY (spec §6 PII rule). Renders counts, total
 * copier PnL and a PnL distribution histogram. Individual copier
 * identifiers are blocked at the SQL layer and never reach this component;
 * the panel says so explicitly (trust through transparency).
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatMoney } from '@/lib/utils/money'
import ProvenanceFooter from '@/app/components/common/ProvenanceFooter'
import ModuleDegraded from './ModuleDegraded'
import type { CopierAggregate } from '@/lib/data/serving/types'

export interface CopierAggregatePanelProps {
  aggregate: CopierAggregate | null
  isLoading?: boolean
  exchangeName?: string
  onRetry?: () => void
}

export default function CopierAggregatePanel({
  aggregate,
  isLoading,
  exchangeName,
  onRetry,
}: CopierAggregatePanelProps) {
  const { t } = useLanguage()

  if (!aggregate) {
    if (isLoading) return null
    return <ModuleDegraded onRetry={onRetry} />
  }

  const maxBucket = Math.max(1, ...aggregate.pnlDistribution.map((b) => b.count))

  return (
    <Box>
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[4],
        }}
      >
        {aggregate.copierCount !== null && (
          <Box
            style={{
              padding: tokens.spacing[3],
              background: tokens.colors.bg.tertiary,
              borderRadius: tokens.radius.lg,
              border: '1px solid ' + tokens.colors.border.primary,
            }}
          >
            <Text size="xs" color="tertiary" style={{ display: 'block', marginBottom: 4 }}>
              {t('copierCountLabel')}
              {aggregate.copierCountMax !== null ? ` / ${aggregate.copierCountMax}` : ''}
            </Text>
            <Text size="lg" weight="bold">
              {aggregate.copierCount.toLocaleString()}
            </Text>
          </Box>
        )}
        {aggregate.totalCopierPnl !== null && (
          <Box
            style={{
              padding: tokens.spacing[3],
              background: tokens.colors.bg.tertiary,
              borderRadius: tokens.radius.lg,
              border: '1px solid ' + tokens.colors.border.primary,
            }}
          >
            <Text size="xs" color="tertiary" style={{ display: 'block', marginBottom: 4 }}>
              {t('copierTotalPnlLabel')}
            </Text>
            <Text
              size="lg"
              weight="bold"
              style={{
                color:
                  aggregate.totalCopierPnl.value > 0
                    ? 'var(--color-success, #22c55e)'
                    : aggregate.totalCopierPnl.value < 0
                      ? 'var(--color-danger, #ef4444)'
                      : tokens.colors.text.primary,
              }}
            >
              {formatMoney(aggregate.totalCopierPnl, { compact: true, signed: true })}
            </Text>
          </Box>
        )}
      </Box>

      {aggregate.pnlDistribution.length > 0 && (
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text
            size="sm"
            weight="bold"
            style={{ display: 'block', marginBottom: tokens.spacing[2] }}
          >
            {t('copierPnlDistribution')}
          </Text>
          {aggregate.pnlDistribution.map((bucket) => (
            <Box
              key={bucket.bucket}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                marginBottom: tokens.spacing[1],
              }}
            >
              <Text
                size="xs"
                color="tertiary"
                style={{ width: 90, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
              >
                {bucket.bucket}
              </Text>
              <Box
                style={{
                  height: 10,
                  width: `${Math.max(2, (bucket.count / maxBucket) * 100)}%`,
                  background: 'var(--color-accent-primary, #6366f1)',
                  borderRadius: tokens.radius.sm,
                  opacity: 0.8,
                }}
              />
              <Text size="xs" color="tertiary">
                {bucket.count.toLocaleString()}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {aggregate.depth !== 'full' && (
        <Text size="xs" color="tertiary" style={{ display: 'block', opacity: 0.7 }}>
          {aggregate.depth === 'top10'
            ? t('copierDepthTop10')
            : aggregate.depth === 'top3_preview'
              ? t('copierDepthTop3')
              : t('copierDepthNone')}
        </Text>
      )}

      <Text size="xs" color="tertiary" style={{ display: 'block', opacity: 0.6, marginTop: 8 }}>
        {t('copierAggregateNotice')}
      </Text>

      <ProvenanceFooter provenance={aggregate.provenance} exchangeName={exchangeName} />
    </Box>
  )
}
