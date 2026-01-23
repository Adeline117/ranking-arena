'use client'

import { useEffect, useRef, useState } from 'react'
import { createChart, ColorType, IChartApi, ISeriesApi, LineSeries, LineData, Time } from 'lightweight-charts'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

export interface EquityDataPoint {
  time: string // YYYY-MM-DD format
  value: number
}

export interface EquityCurveProps {
  data: EquityDataPoint[]
  height?: number
  title?: string
  showTooltip?: boolean
  lineColor?: string
}

/**
 * 资金曲线图表组件
 * 使用 Lightweight Charts (TradingView 开源版) 实现专业金融图表
 */
export default function EquityCurve({
  data,
  height = 300,
  title = 'Equity Curve',
  showTooltip = true,
  lineColor,
}: EquityCurveProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const [tooltipData, setTooltipData] = useState<{ time: string; value: number } | null>(null)
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 })
  const [chartError, setChartError] = useState<string | null>(null)

  // Calculate if overall trend is positive
  const isPositive = data.length >= 2 ? (data[data.length - 1]?.value ?? 0) >= (data[0]?.value ?? 0) : true

  // Default colors based on trend
  const defaultLineColor = isPositive ? tokens.colors.accent.success : tokens.colors.accent.error

  useEffect(() => {
    if (!chartContainerRef.current || data.length === 0) return

    setChartError(null)

    try {
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
        vertLines: { color: tokens.colors.border.primary },
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
        mode: 1, // Normal
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

    // Add line series (v5 API)
    const lineSeries = chart.addSeries(LineSeries, {
      color: lineColor || defaultLineColor,
      lineWidth: 2,
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

    seriesRef.current = lineSeries

    // Transform data for chart
    const chartData: LineData[] = data.map((point) => ({
      time: point.time as Time,
      value: point.value,
    }))

    lineSeries.setData(chartData)
    chart.timeScale().fitContent()

    // Crosshair move handler for tooltip
    if (showTooltip) {
      chart.subscribeCrosshairMove((param) => {
        if (
          param.point === undefined ||
          !param.time ||
          param.point.x < 0 ||
          param.point.y < 0
        ) {
          setTooltipData(null)
          return
        }

        const seriesData = param.seriesData.get(lineSeries)
        if (seriesData && 'value' in seriesData) {
          setTooltipData({
            time: param.time as string,
            value: seriesData.value,
          })
          setTooltipPosition({
            x: param.point.x,
            y: param.point.y,
          })
        }
      })
    }

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
    } catch (err) {
      console.error('Chart creation error:', err)
      setChartError('Failed to load chart')
    }
  }, [data, height, lineColor, defaultLineColor, showTooltip])

  // Calculate stats
  const startValue = data[0]?.value ?? 0
  const endValue = data[data.length - 1]?.value ?? 0
  const changeValue = endValue - startValue
  const changePercent = startValue !== 0 ? ((endValue - startValue) / startValue) * 100 : 0

  return (
    <Box
      bg="secondary"
      p={4}
      radius="md"
      style={{ position: 'relative' }}
    >
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
        {data.length > 0 && (
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <Text
              size="sm"
              weight="bold"
              style={{
                color: changeValue >= 0
                  ? tokens.colors.accent.success
                  : tokens.colors.accent.error,
              }}
            >
              {changeValue >= 0 ? '+' : ''}
              {changePercent.toFixed(2)}%
            </Text>
          </Box>
        )}
      </Box>

      {/* Chart Container */}
      <div ref={chartContainerRef} style={{ width: '100%', height }} />

      {/* Tooltip */}
      {showTooltip && tooltipData && (
        <Box
          style={{
            position: 'absolute',
            left: tooltipPosition.x + 60,
            top: tooltipPosition.y + 60,
            background: tokens.colors.bg.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            padding: tokens.spacing[2],
            pointerEvents: 'none',
            zIndex: tokens.zIndex.dropdown,
            minWidth: 120,
          }}
        >
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            {tooltipData.time}
          </Text>
          <Text size="sm" weight="bold" style={{
            color: tooltipData.value >= startValue
              ? tokens.colors.accent.success
              : tokens.colors.accent.error,
          }}>
            ${tooltipData.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
        </Box>
      )}

      {/* Empty State */}
      {data.length === 0 && !chartError && (
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text size="sm" color="tertiary">
            No equity data available
          </Text>
        </Box>
      )}

      {/* Error State */}
      {chartError && (
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: tokens.spacing[3],
            background: 'rgba(0, 0, 0, 0.3)',
            borderRadius: tokens.radius.md,
          }}
        >
          <Text size="sm" color="tertiary">
            {chartError}
          </Text>
          <button
            onClick={() => setChartError(null)}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              background: tokens.colors.accent.primary,
              color: '#fff',
              border: 'none',
              borderRadius: tokens.radius.md,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </Box>
      )}
    </Box>
  )
}
