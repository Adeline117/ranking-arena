'use client'

/**
 * RecentActivityCard (P2线 2026-07-09) — Overview 的「最近成交」预览卡。
 *
 * arena.order_records 的数据此前只埋在 Stats 深处的 records 子 tab
 * (ServingRecordsSection),Overview 看不到任何交易活动。这里取前 5 行
 * 轻量预览(同一 useTraderRecords 查询键,与 Stats 页共享 React Query 缓存,
 * 零重复网络)。数据缺失/能力关闭时整卡 NULL-collapse。
 */

import { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { t as i18nT } from '@/lib/i18n'
import { useTraderRecords } from '@/lib/hooks/useTraderRecords'
import Metric from '@/app/components/ui/Metric'

interface RecentActivityCardProps {
  source: string
  exchangeTraderId: string
  enabled: boolean
}

interface OrderRow {
  ts?: string
  symbol?: string
  side?: string
  realized_pnl?: number | string | null
}

const ROWS_SHOWN = 5

export const RecentActivityCard = memo(function RecentActivityCard({
  source,
  exchangeTraderId,
  enabled,
}: RecentActivityCardProps) {
  const { rows } = useTraderRecords({
    source,
    exchangeTraderId,
    kind: 'orders',
    tf: 90,
    enabled,
  })
  const recent = ((rows ?? []) as OrderRow[]).slice(0, ROWS_SHOWN)
  if (recent.length === 0) return null

  return (
    <Box
      style={{
        marginTop: tokens.spacing[3],
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.md,
        border: `1px solid var(--color-border-subtle)`,
        background: 'var(--color-bg-secondary)',
      }}
    >
      <Text
        size="sm"
        weight="semibold"
        style={{ marginBottom: tokens.spacing[2], display: 'block' }}
      >
        {i18nT('recentActivityTitle')}
      </Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
        {recent.map((r, i) => {
          const pnl = r.realized_pnl != null ? Number(r.realized_pnl) : null
          const side = (r.side ?? '').toLowerCase()
          return (
            <div
              key={`${r.ts ?? i}-${r.symbol ?? ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              <span
                style={{
                  color:
                    side === 'long' || side === 'buy'
                      ? tokens.colors.accent.success
                      : side === 'short' || side === 'sell'
                        ? tokens.colors.accent.error
                        : tokens.colors.text.tertiary,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  minWidth: 42,
                  textTransform: 'uppercase',
                }}
              >
                {r.side ?? '—'}
              </span>
              <span style={{ flex: 1, color: 'var(--color-text-primary)' }}>{r.symbol ?? '—'}</span>
              {pnl !== null && Number.isFinite(pnl) && (
                <Metric value={pnl} format="pnl" size="sm" align="right" showArrow />
              )}
              <span
                style={{
                  color: tokens.colors.text.tertiary,
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: tokens.typography.fontSize.xs,
                  minWidth: 74,
                  textAlign: 'right',
                }}
              >
                {r.ts ? new Date(r.ts).toLocaleDateString() : ''}
              </span>
            </div>
          )
        })}
      </div>
      <Text
        size="xs"
        style={{
          marginTop: tokens.spacing[2],
          color: tokens.colors.text.tertiary,
          display: 'block',
        }}
      >
        {i18nT('recentActivityViewAll')}
      </Text>
    </Box>
  )
})

export default RecentActivityCard
