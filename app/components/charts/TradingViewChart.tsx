'use client'

import { useEffect, useRef, useCallback } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type DeepPartial,
  type ChartOptions,
  type LineData,
  type CandlestickData,
  type Time,
  ColorType,
  CrosshairMode,
  LineStyle,
} from 'lightweight-charts'

// ============================================
// Types
// ============================================

export interface OHLCVDataPoint {
  time: Time
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export interface LineDataPoint {
  time: Time
  value: number
}

export type ChartType = 'candlestick' | 'line' | 'area'

export interface TradingViewChartProps {
  /** Chart data — OHLCV for candlestick, or { time, value } for line/area */
  data: OHLCVDataPoint[] | LineDataPoint[]
  /** Chart type */
  type?: ChartType
  /** Chart height in pixels */
  height?: number
  /** Theme: 'dark' | 'light' */
  theme?: 'dark' | 'light'
  /** Line/area color override */
  color?: string
  /** Top area color override (for area charts) */
  topColor?: string
  /** Bottom area color override (for area charts) */
  bottomColor?: string
  /** Show volume sub-chart (only for candlestick) */
  showVolume?: boolean
  /** Locale for tooltip labels */
  locale?: 'zh' | 'en'
  /** Additional chart options */
  chartOptions?: DeepPartial<ChartOptions>
}

// ============================================
// Theme helpers
// ============================================

function getChartColors(theme: 'dark' | 'light') {
  if (theme === 'dark') {
    return {
      bg: '#0a0a0a',
      text: '#9E9E9E',
      grid: 'rgba(255,255,255,0.04)',
      border: 'rgba(255,255,255,0.08)',
      crosshair: '#555',
      upColor: '#4DFF9A',
      downColor: '#FF4D4D',
      lineColor: '#8b6fa8',
      areaTop: 'rgba(139, 111, 168, 0.4)',
      areaBottom: 'rgba(139, 111, 168, 0.0)',
      volumeUp: 'rgba(77,255,154,0.25)',
      volumeDown: 'rgba(255,77,77,0.25)',
    }
  }
  return {
    bg: '#FFFFFF',
    text: '#5A5A6A',
    grid: 'rgba(0,0,0,0.04)',
    border: 'rgba(0,0,0,0.08)',
    crosshair: '#999',
    upColor: '#00C853',
    downColor: '#F44336',
    lineColor: '#8b6fa8',
    areaTop: 'rgba(139, 111, 168, 0.3)',
    areaBottom: 'rgba(139, 111, 168, 0.0)',
    volumeUp: 'rgba(0,200,83,0.2)',
    volumeDown: 'rgba(244,67,54,0.2)',
  }
}

// ============================================
// Tooltip labels
// ============================================

const LABELS = {
  zh: { open: '开盘', close: '收盘', high: '最高', low: '最低', volume: '成交量', value: '数值' },
  en: { open: 'Open', close: 'Close', high: 'High', low: 'Low', volume: 'Volume', value: 'Value' },
} as const

// ============================================
// Component
// ============================================

export default function TradingViewChart({
  data,
  type = 'line',
  height = 400,
  theme = 'dark',
  color,
  topColor,
  bottomColor,
  showVolume = false,
  locale = 'zh',
  chartOptions,
}: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)

  const labels = LABELS[locale]
  const colors = getChartColors(theme)

  // Create chart
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: colors.bg },
        textColor: colors.text,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, style: LineStyle.Dashed, width: 1, labelBackgroundColor: colors.crosshair },
        horzLine: { color: colors.crosshair, style: LineStyle.Dashed, width: 1, labelBackgroundColor: colors.crosshair },
      },
      rightPriceScale: {
        borderColor: colors.border,
        scaleMargins: { top: 0.1, bottom: showVolume ? 0.25 : 0.1 },
      },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
      },
      ...chartOptions,
    })

    chartRef.current = chart

    // Create series based on type
    if (type === 'candlestick') {
      const series = chart.addCandlestickSeries({
        upColor: colors.upColor,
        downColor: colors.downColor,
        borderUpColor: colors.upColor,
        borderDownColor: colors.downColor,
        wickUpColor: colors.upColor,
        wickDownColor: colors.downColor,
      })
      series.setData(data as CandlestickData<Time>[])
      seriesRef.current = series

      if (showVolume) {
        const volumeSeries = chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceScaleId: '',
        })
        volumeSeries.priceScale().applyOptions({
          scaleMargins: { top: 0.8, bottom: 0 },
        })
        const volumeData = (data as OHLCVDataPoint[])
          .filter(d => d.volume !== undefined)
          .map(d => ({
            time: d.time,
            value: d.volume!,
            color: d.close >= d.open ? colors.volumeUp : colors.volumeDown,
          }))
        volumeSeries.setData(volumeData)
        volumeRef.current = volumeSeries
      }
    } else if (type === 'area') {
      const series = chart.addAreaSeries({
        lineColor: color || colors.lineColor,
        topColor: topColor || colors.areaTop,
        bottomColor: bottomColor || colors.areaBottom,
        lineWidth: 2,
      })
      series.setData(data as LineData<Time>[])
      seriesRef.current = series
    } else {
      const series = chart.addLineSeries({
        color: color || colors.lineColor,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
      })
      series.setData(data as LineData<Time>[])
      seriesRef.current = series
    }

    // Tooltip
    const tooltip = document.createElement('div')
    tooltip.style.cssText = `
      position: absolute; display: none; padding: 8px 12px; z-index: 10;
      background: ${theme === 'dark' ? 'rgba(20,20,25,0.92)' : 'rgba(255,255,255,0.95)'};
      border: 1px solid ${colors.border}; border-radius: 6px;
      color: ${theme === 'dark' ? '#e0e0e0' : '#333'}; font-size: 12px;
      pointer-events: none; font-family: monospace; line-height: 1.6;
      backdrop-filter: blur(8px); box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    `
    containerRef.current.appendChild(tooltip)
    tooltipRef.current = tooltip

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData || param.seriesData.size === 0) {
        tooltip.style.display = 'none'
        return
      }

      const seriesData = param.seriesData.get(seriesRef.current!)
      if (!seriesData) { tooltip.style.display = 'none'; return }

      let html = ''
      if (type === 'candlestick' && 'open' in seriesData) {
        const d = seriesData as CandlestickData
        const volData = volumeRef.current ? param.seriesData.get(volumeRef.current) : null
        html = `
          <div style="margin-bottom:4px;color:${colors.text}">${String(param.time)}</div>
          <div>${labels.open}: <b>${d.open.toFixed(2)}</b></div>
          <div>${labels.high}: <b>${d.high.toFixed(2)}</b></div>
          <div>${labels.low}: <b>${d.low.toFixed(2)}</b></div>
          <div>${labels.close}: <b style="color:${d.close >= d.open ? colors.upColor : colors.downColor}">${d.close.toFixed(2)}</b></div>
          ${volData && 'value' in volData ? `<div>${labels.volume}: <b>${(volData as LineData).value.toLocaleString()}</b></div>` : ''}
        `
      } else if ('value' in seriesData) {
        const d = seriesData as LineData
        html = `
          <div style="margin-bottom:4px;color:${colors.text}">${String(param.time)}</div>
          <div>${labels.value}: <b>${d.value.toFixed(2)}</b></div>
        `
      }

      tooltip.innerHTML = html
      tooltip.style.display = 'block'

      const container = containerRef.current!
      const toolW = tooltip.offsetWidth
      const x = (param.point?.x ?? 0)
      tooltip.style.left = `${x + toolW + 20 > container.clientWidth ? x - toolW - 10 : x + 10}px`
      tooltip.style.top = `${Math.max(0, (param.point?.y ?? 0) - 60)}px`
    })

    chart.timeScale().fitContent()

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      tooltipRef.current?.remove()
      chartRef.current = null
      seriesRef.current = null
      volumeRef.current = null
    }
  }, [data, type, height, theme, color, topColor, bottomColor, showVolume, locale])

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height }}
    />
  )
}
