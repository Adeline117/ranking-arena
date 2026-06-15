'use client'

/**
 * Drawdown module for serving-mode profiles (ARENA_REBUILD_SPEC §2.5 — risk
 * view). Derives a peak-to-trough drawdown curve from the cumulative ROI
 * series the core modules already return — no extra fetching, no new data.
 *
 * Reuses the existing DrawdownChart primitive (it computes the drawdown and
 * self-handles its own empty/no-drawdown states). We gate on series variation
 * the same way CoreCharts does so a flat all-zero (inactive) trader collapses
 * the whole section instead of showing a misleading "no drawdown" line.
 */

import { useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { DrawdownChart } from '@/app/components/trader/charts/DrawdownChart'

export interface DrawdownModuleProps {
  series: Record<string, Array<{ ts: string; value: number }>>
}

export default function DrawdownModule({ series }: DrawdownModuleProps) {
  const { t } = useLanguage()

  const { equityCurve, hasVariation } = useMemo(() => {
    const roiPoints = series.roi ?? series.roi_trading ?? []
    return {
      equityCurve: roiPoints.map((p) => ({ date: p.ts.slice(0, 10), roi: p.value })),
      hasVariation: roiPoints.length > 1 && new Set(roiPoints.map((p) => p.value)).size > 1,
    }
  }, [series])

  if (!hasVariation) return null

  return (
    <Box>
      <Text
        size="sm"
        weight="semibold"
        color="primary"
        style={{ marginBottom: tokens.spacing[3], display: 'block' }}
      >
        {t('drawdownChart')}
      </Text>
      <DrawdownChart equityCurve={equityCurve} />
    </Box>
  )
}
