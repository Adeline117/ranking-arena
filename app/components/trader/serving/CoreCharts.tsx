'use client'

/**
 * Core ROI/PnL chart for serving-mode profiles (spec §2.4-2). Reuses the
 * existing SimpleLineChart primitive; the serving series map
 * (metric → [{ts,value}]) is merged into its {date, roi, pnl} shape.
 * Metrics with _trading/_bot scope variants get a scope toggle for free
 * by being independent registry keys.
 */

import { useMemo, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { SimpleLineChart } from '@/app/components/trader/stats/components/SimpleLineChart'
import type { ServingTimeframe } from '@/lib/data/serving/types'

export interface CoreChartsProps {
  series: Record<string, Array<{ ts: string; value: number }>>
  timeframe: ServingTimeframe
}

type ChartKey = 'roi' | 'pnl'

function mergeSeries(
  roiPoints: Array<{ ts: string; value: number }>,
  pnlPoints: Array<{ ts: string; value: number }>
): Array<{ date: string; roi: number; pnl: number }> {
  const byDate = new Map<string, { date: string; roi: number; pnl: number }>()
  for (const p of roiPoints) {
    const date = p.ts.slice(0, 10)
    byDate.set(date, { date, roi: p.value, pnl: byDate.get(date)?.pnl ?? 0 })
  }
  for (const p of pnlPoints) {
    const date = p.ts.slice(0, 10)
    const row = byDate.get(date) ?? { date, roi: 0, pnl: 0 }
    row.pnl = p.value
    byDate.set(date, row)
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
}

export default function CoreCharts({ series, timeframe }: CoreChartsProps) {
  const { t } = useLanguage()

  const roiPoints = series.roi ?? series.roi_trading ?? []
  const pnlPoints = series.pnl ?? series.cumulative_pnl ?? series.pnl_trading ?? []

  const hasRoi = roiPoints.length > 0
  const hasPnl = pnlPoints.length > 0
  const [chartKey, setChartKey] = useState<ChartKey>(hasRoi ? 'roi' : 'pnl')

  const data = useMemo(() => mergeSeries(roiPoints, pnlPoints), [roiPoints, pnlPoints])

  if (!hasRoi && !hasPnl) return null

  const period = timeframe === 'inception' ? 'ALL' : `${timeframe}D`
  const activeKey: ChartKey = chartKey === 'roi' && !hasRoi ? 'pnl' : chartKey

  return (
    <Box>
      {hasRoi && hasPnl && (
        <Box style={{ display: 'flex', gap: tokens.spacing[1], marginBottom: tokens.spacing[3] }}>
          {(['roi', 'pnl'] as ChartKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setChartKey(key)}
              aria-pressed={activeKey === key}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: '1px solid ' + tokens.colors.border.primary,
                background: activeKey === key ? tokens.colors.bg.primary : 'transparent',
                color:
                  activeKey === key ? tokens.colors.text.primary : tokens.colors.text.secondary,
                fontSize: 12,
                fontWeight: activeKey === key ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {key === 'roi' ? t('metricRoi') : t('metricPnl')}
            </button>
          ))}
        </Box>
      )}
      <SimpleLineChart data={data} dataKey={activeKey} period={period} />
    </Box>
  )
}
