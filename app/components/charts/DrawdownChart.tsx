'use client'

import { useEffect, useRef } from 'react'
import { createChart, ColorType, IChartApi, LineSeries, LineData, Time } from 'lightweight-charts'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

export interface DrawdownDataPoint {
  time: string // YYYY-MM-DD format
  value: number // Drawdown percentage (negative values)
}

export interface DrawdownChartProps {
  data: DrawdownDataPoint[]
  height?: number
  title?: string
  lineColor?: string
}

/**
 * 回撤曲线图表组件
 * 显示历史最大回撤
 */
export default function DrawdownChart({
  data,
  height = 150,
  title = 'Drawdown',
  lineColor = tokens.colors.accent.error,
}: DrawdownChartProps) {
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
        scaleMargins: { top: 0.05, bottom: 0.05 },
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

    // Add line series for drawdown (v5 API)
    const lineSeries = chart.addSeries(LineSeries, {
      color: lineColor,
      lineWidth: 2,
      priceFormat: {
        type: 'custom',
        formatter: (price: number) => `${price.toFixed(2)}%`,
      },
    })

    // Transform data (ensure all values are negative or zero)
    const chartData: LineData[] = data.map((point) => ({
      time: point.time as Time,
      value: Math.min(0, point.value), // Ensure drawdown is negative
    }))

    lineSeries.setData(chartData)
    chart.timeScale().fitContent()

    // Handle resize with debounce
    let resizeTimer: ReturnType<typeof setTimeout>
    const handleResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (chartContainerRef.current) {
          chart.applyOptions({ width: chartContainerRef.current.clientWidth })
        }
      }, 150)
    }

    window.addEventListener('resize', handleResize)

    return () => {
      clearTimeout(resizeTimer)
      window.removeEventListener('resize', handleResize)
      chart.remove()
    }
  }, [data, height, lineColor])

  // Calculate stats
  const maxDrawdown = Math.min(...data.map((d) => d.value))
  const currentDrawdown = data[data.length - 1]?.value ?? 0
  const avgDrawdown = data.length > 0
    ? data.reduce((sum, d) => sum + d.value, 0) / data.length
    : 0

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
          <Box>
            <Text size="xs" color="tertiary">Max</Text>
            <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.error }}>
              {maxDrawdown.toFixed(2)}%
            </Text>
          </Box>
          <Box>
            <Text size="xs" color="tertiary">Current</Text>
            <Text
              size="xs"
              weight="bold"
              style={{
                color: currentDrawdown < -5
                  ? tokens.colors.accent.error
                  : tokens.colors.accent.warning,
              }}
            >
              {currentDrawdown.toFixed(2)}%
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
            Max Drawdown
          </Text>
          <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.error }}>
            {maxDrawdown.toFixed(2)}%
          </Text>
        </Box>
        <Box style={{ textAlign: 'center' }}>
          <Text size="xs" color="tertiary">
            Avg Drawdown
          </Text>
          <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.warning }}>
            {avgDrawdown.toFixed(2)}%
          </Text>
        </Box>
        <Box style={{ textAlign: 'right' }}>
          <Text size="xs" color="tertiary">
            Recovery
          </Text>
          <Text
            size="sm"
            weight="bold"
            style={{
              color: currentDrawdown > maxDrawdown
                ? tokens.colors.accent.success
                : tokens.colors.text.secondary,
            }}
          >
            {currentDrawdown > maxDrawdown ? 'Recovering' : 'At Low'}
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
            No drawdown data available
          </Text>
        </Box>
      )}
    </Box>
  )
}
