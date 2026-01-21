'use client'

import { useEffect, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { EquityCurve, PnLChart, DrawdownChart } from '../charts'
import type { EquityDataPoint, PnLDataPoint, DrawdownDataPoint } from '../charts'
import { useLanguage } from '../Providers/LanguageProvider'

interface PerformanceChartsProps {
  handle: string
}

type ChartView = 'equity' | 'pnl' | 'drawdown'

/**
 * 交易员绩效图表组件
 * 包含资金曲线、盈亏分布和回撤图表
 */
export default function PerformanceCharts({ handle }: PerformanceChartsProps) {
  const { t } = useLanguage()
  const [activeView, setActiveView] = useState<ChartView>('equity')
  const [equityData, setEquityData] = useState<EquityDataPoint[]>([])
  const [pnlData, setPnlData] = useState<PnLDataPoint[]>([])
  const [drawdownData, setDrawdownData] = useState<DrawdownDataPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const response = await fetch(`/api/traders/${encodeURIComponent(handle)}/equity`)
      if (!response.ok) {
        throw new Error('Failed to fetch chart data')
      }
      const data = await response.json()
      setEquityData(data.equity || [])
      setPnlData(data.pnl || [])
      setDrawdownData(data.drawdown || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [handle])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const chartViews: { id: ChartView; label: string }[] = [
    { id: 'equity', label: t('equityCurve') },
    { id: 'pnl', label: t('pnlDistribution') },
    { id: 'drawdown', label: t('drawdown') },
  ]

  if (loading) {
    return (
      <Box bg="secondary" p={4} radius="md">
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
          {chartViews.map((view) => (
            <Box
              key={view.id}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.tertiary,
              }}
            >
              <Text size="xs" color="tertiary">{view.label}</Text>
            </Box>
          ))}
        </Box>
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 300,
            background: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.md,
          }}
        >
          <Text size="sm" color="tertiary">Loading chart data...</Text>
        </Box>
      </Box>
    )
  }

  if (error) {
    return (
      <Box bg="secondary" p={4} radius="md">
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 200,
          }}
        >
          <Text size="sm" style={{ color: tokens.colors.accent.error }}>
            {error}
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box>
      {/* Chart Tabs */}
      <Box
        style={{
          display: 'flex',
          gap: tokens.spacing[2],
          marginBottom: tokens.spacing[4],
          padding: tokens.spacing[1],
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          width: 'fit-content',
        }}
      >
        {chartViews.map((view) => (
          <button
            key={view.id}
            onClick={() => setActiveView(view.id)}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.md,
              border: 'none',
              background: activeView === view.id ? tokens.colors.bg.tertiary : 'transparent',
              color: activeView === view.id ? tokens.colors.text.primary : tokens.colors.text.tertiary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: activeView === view.id ? tokens.typography.fontWeight.semibold : tokens.typography.fontWeight.normal,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {view.label}
          </button>
        ))}
      </Box>

      {/* Chart Content */}
      {activeView === 'equity' && (
        <EquityCurve
          data={equityData}
          height={350}
          title={t('equityCurve')}
        />
      )}

      {activeView === 'pnl' && (
        <PnLChart
          data={pnlData}
          height={350}
          title={t('pnlDistribution')}
        />
      )}

      {activeView === 'drawdown' && (
        <DrawdownChart
          data={drawdownData}
          height={250}
          title={t('drawdown')}
        />
      )}

      {/* Data Status */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: tokens.spacing[3],
          paddingTop: tokens.spacing[3],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="xs" color="tertiary">
          {equityData.length > 0
            ? `Data from ${equityData[0].time} to ${equityData[equityData.length - 1].time}`
            : 'No historical data available'}
        </Text>
        <Text size="xs" color="tertiary">
          {equityData.length} data points
        </Text>
      </Box>
    </Box>
  )
}
