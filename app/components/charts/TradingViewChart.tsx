'use client'

import { useEffect, useRef } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type DeepPartial,
  type ChartOptions,
  type LineData,
  type CandlestickData,
  type Time,
  type SeriesType,
  ColorType,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
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
  data: OHLCVDataPoint[] | LineDataPoint[]
  type?: ChartType
  height?: number
  theme?: 'dark' | 'light'
  color?: string
  topColor?: string
  bottomColor?: string
  showVolume?: boolean
  locale?: 'zh' | 'en'
  chartOptions?: DeepPartial<ChartOptions>
}

// ============================================
// Theme helpers
// ============================================

function getChartColors(theme: 'dark' | 'light') {
  if (theme === 'dark') {
    return {
      bg: 'var(--color-bg-primary)',
      text: 'var(--color-text-tertiary)',
      grid: 'var(--overlay-hover)',
      border: 'var(--glass-bg-light)',
      crosshair: 'var(--color-text-secondary)',
      upColor: 'var(--color-accent-success)',
      downColor: 'var(--color-accent-error)',
      lineColor: 'var(--color-brand)',
      areaTop: 'var(--color-accent-primary-40)',
      areaBottom: 'var(--color-accent-primary-08)',
      volumeUp: 'var(--color-accent-success-20)',
      volumeDown: 'var(--color-accent-error-20)',
    }
  }
  return {
    bg: 'var(--color-on-accent)',
    text: 'var(--color-text-secondary)',
    grid: 'var(--color-overlay-subtle)',
    border: 'var(--color-overlay-subtle)',
    crosshair: 'var(--color-text-secondary)',
    upColor: 'var(--color-accent-success)',
    downColor: 'var(--color-accent-error)',
    lineColor: 'var(--color-brand)',
    areaTop: 'var(--color-accent-primary-30)',
    areaBottom: 'var(--color-accent-primary-08)',
    volumeUp: 'var(--color-accent-success-20)',
    volumeDown: 'var(--color-accent-error-20)',
  }
}

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
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null)
  const volumeRef = useRef<ISeriesApi<SeriesType> | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)

  const labels = LABELS[locale]
  const colors = getChartColors(theme)

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

    // Create series
    if (type === 'candlestick') {
      const series = chart.addSeries(CandlestickSeries, {
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
        const volumeSeries = chart.addSeries(HistogramSeries, {
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
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
      const series = chart.addSeries(AreaSeries, {
        lineColor: color || colors.lineColor,
        topColor: topColor || colors.areaTop,
        bottomColor: bottomColor || colors.areaBottom,
        lineWidth: 2,
      })
      series.setData(data as LineData<Time>[])
      seriesRef.current = series
    } else {
      const series = chart.addSeries(LineSeries, {
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
      background: ${theme === 'dark' ? 'var(--glass-bg-primary)' : 'var(--glass-bg-heavy)'};
      border: 1px solid ${colors.border}; border-radius: 6px;
      color: ${theme === 'dark' ? 'var(--color-border-primary)' : 'var(--color-text-primary)'}; font-size: 12px;
      pointer-events: none; font-family: monospace; line-height: 1.6;
      backdrop-filter: blur(8px); box-shadow: 0 4px 12px var(--color-overlay-medium);
    `
    containerRef.current.appendChild(tooltip)
    tooltipRef.current = tooltip

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData || param.seriesData.size === 0) {
        tooltip.style.display = 'none'
        return
      }

      const mainData = param.seriesData.get(seriesRef.current!)
      if (!mainData) { tooltip.style.display = 'none'; return }

      let html = ''
      if (type === 'candlestick' && 'open' in mainData) {
        const d = mainData as CandlestickData
        const volData = volumeRef.current ? param.seriesData.get(volumeRef.current) : null
        html = `
          <div style="margin-bottom:4px;color:${colors.text}">${String(param.time)}</div>
          <div>${labels.open}: <b>${d.open.toFixed(2)}</b></div>
          <div>${labels.high}: <b>${d.high.toFixed(2)}</b></div>
          <div>${labels.low}: <b>${d.low.toFixed(2)}</b></div>
          <div>${labels.close}: <b style="color:${d.close >= d.open ? colors.upColor : colors.downColor}">${d.close.toFixed(2)}</b></div>
          ${volData && 'value' in volData ? `<div>${labels.volume}: <b>${(volData as LineData).value.toLocaleString()}</b></div>` : ''}
        `
      } else if ('value' in mainData) {
        const d = mainData as LineData
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
