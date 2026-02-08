'use client'

import { useEffect, useRef } from 'react'
import {
  createChart,
  type IChartApi,
  type LineData,
  type Time,
  ColorType,
  AreaSeries,
} from 'lightweight-charts'

export interface MiniChartProps {
  /** Line data points */
  data: { time: Time; value: number }[]
  /** Chart height (default 40) */
  height?: number
  /** Chart width — leave undefined for 100% container width */
  width?: number
  /** Line color (auto green/red based on trend if omitted) */
  color?: string
  /** Theme */
  theme?: 'dark' | 'light'
}

export default function MiniChart({
  data,
  height = 40,
  width,
  color,
  theme = 'dark',
}: MiniChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current || data.length < 2) return

    const isUp = data[data.length - 1].value >= data[0].value
    const lineColor = color || (isUp ? (theme === 'dark' ? '#4DFF9A' : '#00C853') : (theme === 'dark' ? '#FF4D4D' : '#F44336'))
    const bgColor = theme === 'dark' ? 'transparent' : 'transparent'

    const chart = createChart(containerRef.current, {
      width: width || containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: bgColor },
        textColor: 'transparent',
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        vertLine: { visible: false },
        horzLine: { visible: false },
      },
    })

    const series = chart.addSeries(AreaSeries, {
      lineColor,
      topColor: 'transparent',
      bottomColor: 'transparent',
      lineWidth: 1,
      crosshairMarkerVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
    })

    // For hex colors, compute area fill
    const topFill = lineColor.startsWith('#')
      ? lineColor + '33'
      : lineColor
    series.applyOptions({ topColor: topFill })

    series.setData(data as LineData<Time>[])
    chart.timeScale().fitContent()
    chartRef.current = chart

    const ro = new ResizeObserver(() => {
      if (containerRef.current && !width) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [data, height, width, color, theme])

  if (data.length < 2) {
    return <div style={{ height, width: width || '100%' }} />
  }

  return (
    <div
      ref={containerRef}
      style={{ width: width || '100%', height, overflow: 'hidden' }}
    />
  )
}
