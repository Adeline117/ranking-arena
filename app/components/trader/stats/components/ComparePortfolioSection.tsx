'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../../base'
import { useLanguage } from '../../../Providers/LanguageProvider'
import { t as i18nT } from '@/lib/i18n'
import type { LineData, Time } from 'lightweight-charts'

interface EquityCurveData {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

interface ComparePortfolioSectionProps {
  traderHandle: string
  equityCurve?: EquityCurveData
  delay: number
}

export function ComparePortfolioSection({
  traderHandle,
  equityCurve,
  delay
}: ComparePortfolioSectionProps) {
  const { t } = useLanguage()
  const [period, setPeriod] = useState<'7D' | '30D' | '90D'>('90D')
  const [compareWith, setCompareWith] = useState<'BTC' | 'SPX500'>('BTC')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), delay * 1000)
    return () => clearTimeout(timer)
  }, [delay])

  // 获取当前周期的交易员数据
  const currentData = equityCurve?.[period] || []
  const hasData = currentData.length > 0

  // 所有周期都没有数据时，隐藏整个section
  const allPeriodsEmpty = !equityCurve || (
    (!equityCurve['90D'] || equityCurve['90D'].length === 0) &&
    (!equityCurve['30D'] || equityCurve['30D'].length === 0) &&
    (!equityCurve['7D'] || equityCurve['7D'].length === 0)
  )

  if (allPeriodsEmpty) {
    return null
  }

  // 计算交易员的总ROI
  const traderTotalRoi = hasData
    ? currentData[currentData.length - 1]?.roi || 0
    : undefined

  return (
    <Box
      className="stats-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 4px 24px var(--color-overlay-subtle)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black">{t('compareAnalysis')}</Text>
        </Box>
        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          <PeriodSelector value={period} onChange={setPeriod} t={t} />
          <select
            value={compareWith}
            onChange={(e) => setCompareWith(e.target.value as 'BTC' | 'SPX500')}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.bold,
              cursor: 'pointer',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            <option value="BTC">{i18nT('vsBtcOption')}</option>
            <option value="SPX500">vs SPX500</option>
          </select>
        </Box>
      </Box>

      {hasData ? (
        <>
          <CompareChart
            height={220}
            period={period}
            compareWith={compareWith}
            traderData={currentData}
            traderHandle={traderHandle}
          />

          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], marginTop: tokens.spacing[4] }}>
            <CompareRow name={traderHandle} pct={traderTotalRoi} color={tokens.colors.accent.primary} />
            <CompareRow name={compareWith} pct={undefined} color={tokens.colors.accent.warning} />
          </Box>
        </>
      ) : null}
    </Box>
  )
}

function CompareChart({
  height,
  period,
  compareWith,
  traderData: rawTraderData,
  traderHandle
}: {
  height: number
  period: string
  compareWith: 'BTC' | 'SPX500'
  traderData: Array<{ date: string; roi: number; pnl: number }>
  traderHandle: string
}) {
  const { t } = useLanguage()
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  // 确保客户端渲染
  useEffect(() => {
    setMounted(true)
  }, [])

  // 使用真实交易员数据 + 生成对比资产数据
  const chartData = useMemo(() => {
    const days = period === '7D' ? 7 : period === '30D' ? 30 : 90

    // 转换交易员真实数据为图表格式
    const traderChartData: LineData[] = rawTraderData.map(item => ({
      time: item.date as Time,
      value: 100 + item.roi, // ROI转换为以100为基准的值
    }))

    // 生成对比资产曲线（BTC/SPX500）
    const compareData: LineData[] = []
    const compareBaseReturn = compareWith === 'BTC' ? 12 : 6
    let compareValue = 100

    // 使用确定性的伪随机数，基于 traderHandle 生成不同的种子
    const handleHash = traderHandle.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const seed = days + (compareWith === 'BTC' ? 1 : 2) + handleHash
    const seededRandom = (i: number) => {
      const x = Math.sin(seed * 9999 + i * 7777) * 10000
      return x - Math.floor(x)
    }

    // 使用交易员数据的日期范围
    if (rawTraderData.length > 0) {
      rawTraderData.forEach((item, i) => {
        const compareDailyChange = (seededRandom(i * 2 + 1) - 0.45) * 1.5 + (compareBaseReturn / days)
        compareValue = Math.max(95, compareValue + compareDailyChange)
        compareData.push({ time: item.date as Time, value: compareValue })
      })
    }

    return { traderData: traderChartData, compareData }
  }, [period, compareWith, rawTraderData, traderHandle])

  useEffect(() => {
    if (!mounted || !chartContainerRef.current) return

    let disposed = false
    let resizeHandler: (() => void) | null = null
    let chartInstance: { remove: () => void } | null = null

    // Dynamically import lightweight-charts to keep it out of the initial bundle
    import('lightweight-charts').then(({ createChart, ColorType, LineSeries }) => {
      if (disposed || !chartContainerRef.current) return

      const container = chartContainerRef.current
      const containerWidth = container.clientWidth || 400
      const chartHeight = height - 16

      // 创建图表
      const chart = createChart(container, {
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: tokens.colors.text.tertiary,
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
        },
        width: containerWidth,
        height: chartHeight,
        grid: {
          vertLines: { color: `${tokens.colors.border.primary}30` },
          horzLines: { color: `${tokens.colors.border.primary}30` },
        },
        rightPriceScale: {
          borderColor: tokens.colors.border.primary,
          scaleMargins: { top: 0.1, bottom: 0.1 },
        },
        timeScale: {
          borderColor: tokens.colors.border.primary,
          timeVisible: false,
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

      chartInstance = chart

      // 添加用户ROI线（紫色）
      const traderSeries = chart.addSeries(LineSeries, {
        color: tokens.colors.accent.primary,
        lineWidth: 2,
        priceFormat: {
          type: 'custom',
          formatter: (price: number) => `${(price - 100).toFixed(1)}%`,
        },
      })
      traderSeries.setData(chartData.traderData)

      // 添加比较资产线（橙色）
      const compareSeries = chart.addSeries(LineSeries, {
        color: tokens.colors.accent.warning,
        lineWidth: 2,
        priceFormat: {
          type: 'custom',
          formatter: (price: number) => `${(price - 100).toFixed(1)}%`,
        },
      })
      compareSeries.setData(chartData.compareData)

      chart.timeScale().fitContent()

      // 响应式调整
      resizeHandler = () => {
        if (container) {
          chart.applyOptions({ width: container.clientWidth })
        }
      }

      window.addEventListener('resize', resizeHandler)
    }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget

    return () => {
      disposed = true
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler)
      }
      if (chartInstance) {
        chartInstance.remove()
      }
    }
  }, [mounted, chartData, height])

  // 服务端或未挂载时显示占位符
  if (!mounted) {
    return (
      <Box
        style={{
          height,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}40`,
          background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}30 100%)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text size="sm" color="tertiary">{t('loadingChart')}</Text>
      </Box>
    )
  }

  return (
    <Box
      style={{
        height,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}40`,
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}30 100%)`,
        position: 'relative',
        overflow: 'hidden',
        padding: 8,
      }}
    >
      <div ref={chartContainerRef} style={{ width: '100%', height: height - 16 }} />
    </Box>
  )
}

function CompareRow({ name, pct, color }: { name: string; pct?: number; color: string }) {
  return (
    <Box style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
      background: tokens.colors.bg.tertiary,
      borderRadius: tokens.radius.lg,
    }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        <Box style={{ width: 10, height: 10, borderRadius: tokens.radius.full, background: color }} />
        <Text size="sm" weight="bold" style={{ color: tokens.colors.text.secondary }}>
          {name}
        </Text>
      </Box>
      <Text
        size="sm"
        weight="black"
        style={{
          color: pct !== undefined
            ? (pct >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error)
            : tokens.colors.text.tertiary,
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
        }}
      >
        {pct !== undefined ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : i18nT('notAvailable')}
      </Text>
    </Box>
  )
}

// Period Selector Component
function PeriodSelector({
  value,
  onChange,
  t: _t
}: {
  value: '7D' | '30D' | '90D'
  onChange: (v: '7D' | '30D' | '90D') => void
  t: (key: string) => string
}) {
  return (
    <Box
      style={{
        display: 'flex',
        gap: 2,
        background: tokens.colors.bg.tertiary,
        padding: 2,
        borderRadius: tokens.radius.md,
      }}
    >
      {(['7D', '30D', '90D'] as const).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.sm,
            border: 'none',
            background: value === p ? tokens.colors.bg.primary : 'transparent',
            color: value === p ? tokens.colors.text.primary : tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: value === p ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
            cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          {p}
        </button>
      ))}
    </Box>
  )
}
