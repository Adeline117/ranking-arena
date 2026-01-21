'use client'

import { useEffect, useRef } from 'react'
import { createChart, ColorType, IChartApi, HistogramSeries, HistogramData, Time } from 'lightweight-charts'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

export interface PnLDataPoint {
  time: string // YYYY-MM-DD format
  value: number // PnL value (positive or negative)
}

export interface PnLChartProps {
  data: PnLDataPoint[]
  height?: number
  title?: string
  positiveColor?: string
  negativeColor?: string
}

/**
 * 盈亏分布柱状图组件
 * 显示每日/每周盈亏分布
 */
export default function PnLChart({
  data,
  height = 200,
  title = 'PnL Distribution',
  positiveColor = tokens.colors.accent.success,
  negativeColor = tokens.colors.accent.error,
}: PnLChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!chartContainerRef.current || data.length === 0) return

    // Create chart
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: tokens.colors.text.tertiary,
        fontFamily: tokens.typography.fontFamily.mono.join(', '),
      },
      width: chartContainerRef.current.clientWidth,
      height,
      grid: {
        vertLines: { visible: false },
        horzLines: { color: tokens.colors.border.primary },
      },
      rightPriceScale: {
        borderColor: tokens.colors.border.primary,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: tokens.colors.border.primary,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: tokens.colors.text.tertiary,
          width: 1,
          labelBackgroundColor: tokens.colors.bg.tertiary,
        },
        horzLine: {
          color: tokens.colors.text.tertiary,
          width: 1,
          labelBackgroundColor: tokens.colors.bg.tertiary,
        },
      },
    })

    chartRef.current = chart

    // Add histogram series (v5 API)
    const histogramSeries = chart.addSeries(HistogramSeries, {
      priceFormat: {
        type: 'custom',
        formatter: (price: number) => {
          if (Math.abs(price) >= 1000000) {
            return `$${(price / 1000000).toFixed(2)}M`
          } else if (Math.abs(price) >= 1000) {
            return `$${(price / 1000).toFixed(2)}K`
          }
          return `$${price.toFixed(2)}`
        },
      },
    })

    // Transform data with colors
    const chartData: HistogramData[] = data.map((point) => ({
      time: point.time as Time,
      value: point.value,
      color: point.value >= 0 ? positiveColor : negativeColor,
    }))

    histogramSeries.setData(chartData)
    chart.timeScale().fitContent()

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth })
      }
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
    }
  }, [data, height, positiveColor, negativeColor])

  // Calculate stats
  const totalPnL = data.reduce((sum, d) => sum + d.value, 0)
  const winDays = data.filter((d) => d.value > 0).length
  const lossDays = data.filter((d) => d.value < 0).length
  const winRate = data.length > 0 ? (winDays / data.length) * 100 : 0

  return (
    <Box bg="secondary" p={4} radius="md">
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing[4],
        }}
      >
        <Text size="sm" weight="semibold" color="primary">
          {title}
        </Text>
        <Box style={{ display: 'flex', gap: tokens.spacing[4] }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
            <Box
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: positiveColor,
              }}
            />
            <Text size="xs" color="tertiary">
              Win: {winDays}
            </Text>
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
            <Box
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: negativeColor,
              }}
            />
            <Text size="xs" color="tertiary">
              Loss: {lossDays}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Chart Container */}
      <div ref={chartContainerRef} style={{ width: '100%', height }} />

      {/* Stats Footer */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: tokens.spacing[3],
          paddingTop: tokens.spacing[3],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box>
          <Text size="xs" color="tertiary">
            Total PnL
          </Text>
          <Text
            size="sm"
            weight="bold"
            style={{
              color: totalPnL >= 0
                ? tokens.colors.accent.success
                : tokens.colors.accent.error,
            }}
          >
            {totalPnL >= 0 ? '+' : ''}${Math.abs(totalPnL).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
        </Box>
        <Box style={{ textAlign: 'right' }}>
          <Text size="xs" color="tertiary">
            Win Rate
          </Text>
          <Text
            size="sm"
            weight="bold"
            style={{
              color: winRate >= 50
                ? tokens.colors.accent.success
                : tokens.colors.accent.error,
            }}
          >
            {winRate.toFixed(1)}%
          </Text>
        </Box>
      </Box>

      {/* Empty State */}
      {data.length === 0 && (
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height,
          }}
        >
          <Text size="sm" color="tertiary">
            No PnL data available
          </Text>
        </Box>
      )}
    </Box>
  )
}
