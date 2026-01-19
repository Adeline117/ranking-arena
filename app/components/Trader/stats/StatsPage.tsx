'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../Base'
import type { TraderStats } from '@/lib/data/trader'
import TradingViewShell from '../TradingViewShell'
import { useLanguage } from '../../Utils/LanguageProvider'
import { createChart, ColorType, IChartApi, LineSeries, LineData, Time } from 'lightweight-charts'

// 扩展类型以支持新数据
interface AssetBreakdownData {
  '90D': Array<{ symbol: string; weightPct: number }>
  '30D': Array<{ symbol: string; weightPct: number }>
  '7D': Array<{ symbol: string; weightPct: number }>
}

interface EquityCurveData {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

interface PositionHistoryItem {
  symbol: string
  direction: string
  positionType: string
  marginMode: string
  openTime: string
  closeTime: string
  entryPrice: number
  exitPrice: number
  maxPositionSize: number
  closedSize: number
  pnlUsd: number
  pnlPct: number
  status: string
}

interface ExtendedStatsPageProps {
  stats: TraderStats
  traderHandle: string
  assetBreakdown?: AssetBreakdownData
  equityCurve?: EquityCurveData
  positionHistory?: PositionHistoryItem[]
}

export default function StatsPage({ 
  stats, 
  traderHandle, 
  assetBreakdown,
  equityCurve,
  positionHistory = [],
}: ExtendedStatsPageProps) {
  const { t } = useLanguage()
  const [mounted, setMounted] = useState(false)
  
  useEffect(() => {
    setMounted(true)
  }, [])
  
  const frequentlyTraded = stats.frequentlyTraded || []
  const trading = stats.trading
  const additionalStats = stats.additionalStats

  return (
    <Box 
      style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        gap: tokens.spacing[6],
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {/* Asset Breakdown */}
      <BreakdownSection 
        assetBreakdown={assetBreakdown} 
        fallbackData={frequentlyTraded} 
        delay={0}
      />

      {/* Chart + Compare Two Columns */}
      <Box className="stats-two-col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacing[6] }}>
        <EquityCurveSection equityCurve={equityCurve} traderHandle={traderHandle} delay={0.1} />
        <ComparePortfolioSection traderHandle={traderHandle} equityCurve={equityCurve} delay={0.15} />
      </Box>

      {/* Trading Section */}
      <TradingSection 
        trading={trading} 
        additionalStats={additionalStats}
        positionHistory={positionHistory}
        t={t}
        delay={0.2}
      />
    </Box>
  )
}

// Trading Section Component
function TradingSection({ 
  trading, 
  additionalStats, 
  positionHistory,
  t,
  delay 
}: { 
  trading: TraderStats['trading']
  additionalStats: TraderStats['additionalStats']
  positionHistory: PositionHistoryItem[]
  t: (key: string) => string
  delay: number
}) {
  const [mounted, setMounted] = useState(false)
  
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), delay * 1000)
    return () => clearTimeout(timer)
  }, [delay])

  return (
    <Box
      className="stats-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[5] }}>
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          Trading
        </Text>
      </Box>

      {trading && (trading.totalTrades12M > 0 || trading.profitableTradesPct > 0) ? (
        <Box
          className="trading-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: tokens.spacing[4],
            marginBottom: tokens.spacing[6],
          }}
        >
          <MiniKpi label="Total Trades (90D)" value={trading.totalTrades12M > 0 ? String(trading.totalTrades12M) : 'N/A'} />
          <MiniKpi
            label="Avg. Profit / Loss"
            value={trading.avgProfit > 0 || trading.avgLoss < 0 
              ? `${trading.avgProfit.toFixed(2)}% / ${trading.avgLoss.toFixed(2)}%`
              : 'N/A'
            }
          />
          <MiniKpi label="Profitable Trades" value={trading.profitableTradesPct > 0 ? `${trading.profitableTradesPct.toFixed(2)}%` : 'N/A'} />
        </Box>
      ) : (
        <Box style={{ 
          padding: tokens.spacing[6], 
          textAlign: 'center', 
          marginBottom: tokens.spacing[6],
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}>
          <Text size="sm" color="tertiary">
            交易统计数据暂不可用
          </Text>
        </Box>
      )}

      {positionHistory.length > 0 && (
        <PositionHistorySection positionHistory={positionHistory} t={t} />
      )}

      {/* Additional Stats */}
      <Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
          <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
            Additional stats
          </Text>
        </Box>
        <Box className="trading-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[4] }}>
          <MiniKpi 
            label={t('avgHoldingTime')} 
            value={additionalStats?.avgHoldingTime || 'N/A'} 
          />
          <MiniKpi 
            label={t('maxDrawdown')} 
            value={additionalStats?.maxDrawdown !== undefined ? `-${Math.abs(additionalStats.maxDrawdown).toFixed(2)}%` : 'N/A'} 
            highlight={additionalStats?.maxDrawdown !== undefined}
            isNegative
          />
          <MiniKpi 
            label="Tracked since" 
            value={additionalStats?.activeSince || 'N/A'} 
          />
        </Box>
      </Box>
    </Box>
  )
}

// Mini KPI Component
function MiniKpi({ 
  label, 
  value, 
  highlight,
  isNegative 
}: { 
  label: string
  value: string
  highlight?: boolean
  isNegative?: boolean
}) {
  const [isHovered, setIsHovered] = useState(false)

  return (
    <Box 
      className="metric-item"
      style={{
        background: isHovered ? `${tokens.colors.accent.primary}08` : tokens.colors.bg.primary,
        padding: tokens.spacing[4],
        borderRadius: tokens.radius.xl,
        border: `1px solid ${isHovered ? tokens.colors.accent.primary + '30' : tokens.colors.border.primary}`,
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        transform: isHovered ? 'translateY(-2px)' : 'translateY(0)',
        cursor: 'default',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
        <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
          {label}
        </Text>
      </Box>
      <Text 
        size="xl" 
        weight="black" 
        style={{ 
          color: value === 'N/A' 
            ? tokens.colors.text.tertiary 
            : (highlight && isNegative ? tokens.colors.accent.error : tokens.colors.text.primary),
          fontFamily: value !== 'N/A' && !value.includes('/') ? tokens.typography.fontFamily.mono.join(', ') : 'inherit',
        }}
      >
        {value}
      </Text>
    </Box>
  )
}

// Equity Curve Section
function EquityCurveSection({ 
  equityCurve, 
  traderHandle,
  delay 
}: { 
  equityCurve?: EquityCurveData
  traderHandle: string 
  delay: number
}) {
  const { t } = useLanguage()
  const [period, setPeriod] = useState<'7D' | '30D' | '90D'>('90D')
  const [chartType, setChartType] = useState<'roi' | 'pnl'>('roi')
  const [mounted, setMounted] = useState(false)
  
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), delay * 1000)
    return () => clearTimeout(timer)
  }, [delay])
  
  const currentData = equityCurve?.[period] || []
  const hasData = currentData.length > 0

  return (
    <Box 
      className="stats-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        {/* Chart Type Toggle */}
        <Box
          style={{
            display: 'flex',
            gap: 2,
            background: tokens.colors.bg.tertiary,
            padding: 3,
            borderRadius: tokens.radius.lg,
          }}
        >
          {(['roi', 'pnl'] as const).map((type) => (
            <button
              key={type}
              onClick={() => setChartType(type)}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: chartType === type 
                  ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
                  : 'transparent',
                color: chartType === type ? '#fff' : tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.bold,
                cursor: 'pointer',
                transition: 'all 0.25s ease',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {type === 'roi' ? t('roi') : t('pnl')}
            </button>
          ))}
        </Box>
        
        {/* Period Selector */}
        <PeriodSelector value={period} onChange={setPeriod} t={t} />
      </Box>

      {hasData ? (
        <Box style={{ height: 280 }}>
          <SimpleLineChart 
            data={currentData} 
            dataKey={chartType} 
            period={period}
          />
        </Box>
      ) : (
        <Box 
          style={{ 
            overflow: 'hidden',
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <TradingViewShell symbol={traderHandle} timeframe={period} />
        </Box>
      )}
    </Box>
  )
}

// Period Selector Component
function PeriodSelector({ 
  value, 
  onChange, 
  t 
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
            transition: 'all 0.2s ease',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          {p}
        </button>
      ))}
    </Box>
  )
}

// Simple Line Chart
function SimpleLineChart({ 
  data, 
  dataKey,
  period,
}: { 
  data: Array<{ date: string; roi: number; pnl: number }>
  dataKey: 'roi' | 'pnl'
  period: string
}) {
  if (data.length === 0) {
    return (
      <Box style={{ 
        height: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        background: tokens.colors.bg.primary,
        borderRadius: tokens.radius.lg,
      }}>
        <Text size="sm" color="tertiary">暂无 {period} 数据</Text>
      </Box>
    )
  }

  const values = data.map(d => d[dataKey])
  const maxValue = Math.max(...values)
  const minValue = Math.min(...values)
  const range = maxValue - minValue || 1
  
  const width = 100
  const height = 100
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((d[dataKey] - minValue) / range) * height
    return `${x},${y}`
  })
  const pathD = `M ${points.join(' L ')}`
  
  const isPositive = values[values.length - 1] >= values[0]
  const color = isPositive ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <Box style={{ 
      height: '100%', 
      background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}40 100%)`, 
      borderRadius: tokens.radius.xl,
      padding: tokens.spacing[4],
      position: 'relative',
      border: `1px solid ${tokens.colors.border.primary}40`,
    }}>
      {/* Y-axis Labels */}
      <Box style={{ 
        position: 'absolute', 
        left: tokens.spacing[3], 
        top: tokens.spacing[4], 
        bottom: tokens.spacing[8],
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}>
        <Text size="xs" color="tertiary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
          {dataKey === 'roi' ? `${maxValue.toFixed(0)}%` : `$${(maxValue / 1000).toFixed(0)}K`}
        </Text>
        <Text size="xs" color="tertiary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
          {dataKey === 'roi' ? `${minValue.toFixed(0)}%` : `$${(minValue / 1000).toFixed(0)}K`}
        </Text>
      </Box>
      
      {/* Chart Area */}
      <Box style={{ 
        marginLeft: 55, 
        height: 'calc(100% - 32px)',
        position: 'relative',
      }}>
        <svg 
          viewBox={`0 0 ${width} ${height}`} 
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%' }}
        >
          {/* Grid */}
          {[0, 25, 50, 75, 100].map(y => (
            <line key={y} x1="0" y1={y} x2="100" y2={y} stroke={tokens.colors.border.primary} strokeWidth="0.3" strokeDasharray="2,2" />
          ))}
          
          {/* Area Fill */}
          <path
            d={`${pathD} L 100,100 L 0,100 Z`}
            fill={`url(#gradient-${isPositive ? 'positive' : 'negative'})`}
            opacity="0.3"
          />
          
          {/* Line */}
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          
          {/* Gradient Definitions */}
          <defs>
            <linearGradient id="gradient-positive" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.colors.accent.success} stopOpacity="0.4" />
              <stop offset="100%" stopColor={tokens.colors.accent.success} stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gradient-negative" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.colors.accent.error} stopOpacity="0.4" />
              <stop offset="100%" stopColor={tokens.colors.accent.error} stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
      </Box>
      
      {/* X-axis Labels */}
      <Box style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        marginLeft: 55,
        marginTop: tokens.spacing[2],
      }}>
        <Text size="xs" color="tertiary">
          {data[0]?.date ? new Date(data[0].date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}
        </Text>
        <Text size="xs" color="tertiary">
          {data[data.length - 1]?.date ? new Date(data[data.length - 1].date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}
        </Text>
      </Box>
    </Box>
  )
}

// Compare Portfolio Section
function ComparePortfolioSection({ 
  traderHandle, 
  equityCurve,
  delay 
}: { 
  traderHandle: string
  equityCurve?: EquityCurveData
  delay: number 
}) {
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
        boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black">Compare</Text>
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
            <option value="BTC">vs BTC</option>
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
      ) : (
        <Box style={{ 
          padding: tokens.spacing[8], 
          textAlign: 'center',
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}>
          <Text size="sm" color="tertiary">
            暂无对比数据
          </Text>
          <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
            需要更多历史收益数据才能生成对比图表
          </Text>
        </Box>
      )}
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
    const handleResize = () => {
      if (container) {
        chart.applyOptions({ width: container.clientWidth })
      }
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
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
        <Text size="sm" color="tertiary">加载图表中...</Text>
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
        {pct !== undefined ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : 'N/A'}
      </Text>
    </Box>
  )
}

// Breakdown Section (Asset Preference)
function BreakdownSection({ 
  assetBreakdown,
  fallbackData,
  delay,
}: { 
  assetBreakdown?: AssetBreakdownData
  fallbackData: Array<{ symbol: string; weightPct: number }> 
  delay: number
}) {
  const { t } = useLanguage()
  const [period, setPeriod] = useState<'7D' | '30D' | '90D'>('90D')
  const [mounted, setMounted] = useState(false)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), delay * 1000)
    return () => clearTimeout(timer)
  }, [delay])
  
  const currentData = assetBreakdown?.[period] || fallbackData
  
  if (currentData.length === 0) {
    return (
      <Box 
        className="stats-card glass-card"
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}60`,
          padding: tokens.spacing[6],
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(20px)',
          transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <Text size="lg" weight="black">{t('assetBreakdown')}</Text>
          </Box>
          <PeriodSelector value={period} onChange={setPeriod} t={t} />
        </Box>
        <Box style={{ 
          padding: tokens.spacing[8], 
          textAlign: 'center',
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}>
          <Text size="sm" color="tertiary">
            资产分布数据暂不可用
          </Text>
        </Box>
      </Box>
    )
  }

  const totalPct = currentData.reduce((sum, item) => sum + item.weightPct, 0)

  return (
    <Box 
      className="stats-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[5] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black">{t('assetBreakdown')}</Text>
        </Box>
        <PeriodSelector value={period} onChange={setPeriod} t={t} />
      </Box>

      {/* Horizontal Bar Chart */}
      <Box style={{ marginBottom: tokens.spacing[5] }}>
        <Box 
          style={{ 
            display: 'flex', 
            height: 32, 
            borderRadius: tokens.radius.xl, 
            overflow: 'hidden',
            background: tokens.colors.bg.tertiary,
            boxShadow: `inset 0 2px 4px rgba(0, 0, 0, 0.1)`,
          }}
        >
          {currentData.slice(0, 10).map((item, idx) => (
            <Box
              key={idx}
              className="asset-bar"
              style={{
                width: `${(item.weightPct / totalPct) * 100}%`,
                background: getColorForIndex(idx),
                minWidth: 4,
                transition: 'all 0.3s ease',
                opacity: hoveredIndex === null || hoveredIndex === idx ? 1 : 0.4,
                transform: hoveredIndex === idx ? 'scaleY(1.15)' : 'scaleY(1)',
              }}
              title={`${item.symbol}: ${item.weightPct.toFixed(2)}%`}
              onMouseEnter={() => setHoveredIndex(idx)}
              onMouseLeave={() => setHoveredIndex(null)}
            />
          ))}
        </Box>
      </Box>

      {/* Asset List */}
      <Box className="asset-grid" style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(3, 1fr)', 
        gap: tokens.spacing[3],
      }}>
        {currentData.slice(0, 12).map((item, idx) => (
          <Box 
            key={idx} 
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.lg,
              background: hoveredIndex === idx ? `${getColorForIndex(idx)}15` : 'transparent',
              transition: 'all 0.2s ease',
              cursor: 'default',
            }}
            onMouseEnter={() => setHoveredIndex(idx)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <Box 
              style={{ 
                width: 10, 
                height: 10, 
                borderRadius: tokens.radius.sm, 
                background: getColorForIndex(idx), 
                flexShrink: 0,
                boxShadow: `0 2px 4px ${getColorForIndex(idx)}40`,
              }} 
            />
            <Text size="sm" weight="bold" style={{ flex: 1, color: tokens.colors.text.primary }}>{item.symbol}</Text>
            <Text 
              size="sm" 
              style={{ 
                color: tokens.colors.text.secondary,
                fontFamily: tokens.typography.fontFamily.mono.join(', '),
              }}
            >
              {item.weightPct.toFixed(1)}%
            </Text>
          </Box>
        ))}
      </Box>
      
      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[4] }}>
        *数据每 1-2 小时刷新一次
      </Text>
    </Box>
  )
}

// Position History Section
function PositionHistorySection({ positionHistory, t }: { positionHistory: PositionHistoryItem[]; t: (key: string) => string }) {
  const [sortBy, setSortBy] = useState<'openTime' | 'closeTime'>('openTime')
  const [expanded, setExpanded] = useState(false)
  const COLLAPSED_COUNT = 3
  
  const sortedHistory = [...positionHistory].sort((a, b) => {
    const dateA = new Date(a[sortBy] || 0).getTime()
    const dateB = new Date(b[sortBy] || 0).getTime()
    return dateB - dateA
  })

  const displayedHistory = expanded ? sortedHistory : sortedHistory.slice(0, COLLAPSED_COUNT)

  return (
    <Box style={{ marginBottom: tokens.spacing[6] }}>
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black">{t('positionHistory')}</Text>
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="xs" color="tertiary">{t('sortBy')}</Text>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'openTime' | 'closeTime')}
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
            <option value="openTime">{t('openTime')}</option>
            <option value="closeTime">{t('closeTime')}</option>
          </select>
        </Box>
      </Box>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {displayedHistory.map((item, idx) => (
          <PositionHistoryCard key={idx} position={item} />
        ))}
      </Box>

      {sortedHistory.length > COLLAPSED_COUNT && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            width: '100%',
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            marginTop: tokens.spacing[3],
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.tertiary,
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
            textAlign: 'center',
          }}
        >
          {expanded ? '收起' : `展开全部 (${sortedHistory.length} 条)`}
        </button>
      )}
    </Box>
  )
}

// Position History Card
function PositionHistoryCard({ position }: { position: PositionHistoryItem }) {
  const isLong = position.direction === 'long'
  const isProfit = position.pnlUsd >= 0
  
  const formatTime = (timeStr: string) => {
    if (!timeStr) return '--'
    const date = new Date(timeStr)
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatPrice = (price: number) => {
    if (!price) return '--'
    return price >= 1 ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : price.toFixed(4)
  }

  return (
    <Box 
      className="position-card"
      style={{ 
        background: tokens.colors.bg.primary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.xl,
        padding: tokens.spacing[4],
      }}
    >
      {/* Header */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
        <Box style={{ 
          width: 28, 
          height: 28, 
          borderRadius: tokens.radius.full, 
          background: `linear-gradient(135deg, #F7931A, #E6A200)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 2px 8px rgba(247, 147, 26, 0.3)',
        }}>
          <Text size="xs" weight="bold" style={{ color: '#fff' }}>{position.symbol.slice(0, 2)}</Text>
        </Box>
        
        <Text size="base" weight="black" style={{ color: tokens.colors.text.primary }}>{position.symbol}</Text>
        
        <Box style={{ display: 'flex', gap: tokens.spacing[1], marginLeft: 'auto' }}>
          <Box style={{ 
            padding: `2px 8px`, 
            borderRadius: tokens.radius.full,
            background: tokens.colors.bg.tertiary,
          }}>
            <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
              {position.positionType === 'perpetual' ? '永续' : '交割'}
            </Text>
          </Box>
          <Box style={{ 
            padding: `2px 10px`, 
            borderRadius: tokens.radius.full,
            background: isLong ? `${tokens.colors.accent.success}15` : `${tokens.colors.accent.error}15`,
            border: `1px solid ${isLong ? tokens.colors.accent.success : tokens.colors.accent.error}30`,
          }}>
            <Text size="xs" style={{ 
              color: isLong ? tokens.colors.accent.success : tokens.colors.accent.error,
              fontWeight: 600,
            }}>
              {isLong ? '做多' : '做空'}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Data Grid */}
      <Box style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(4, 1fr)', 
        gap: tokens.spacing[4],
      }}>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: 4, display: 'block' }}>开仓</Text>
          <Text size="sm" weight="bold" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            {formatTime(position.openTime)}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: 4, display: 'block' }}>开仓价</Text>
          <Text size="sm" weight="bold" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            ${formatPrice(position.entryPrice)}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: 4, display: 'block' }}>平仓价</Text>
          <Text size="sm" style={{ color: tokens.colors.text.secondary, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            ${formatPrice(position.exitPrice)}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: 4, display: 'block' }}>盈亏</Text>
          <Text 
            size="sm" 
            weight="black" 
            style={{ 
              color: isProfit ? tokens.colors.accent.success : tokens.colors.accent.error,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
            }}
          >
            {isProfit ? '+' : ''}{position.pnlUsd.toFixed(2)} USDT
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

function getColorForIndex(idx: number): string {
  const colors = [
    '#3B82F6', // Blue
    '#F59E0B', // Amber
    '#10B981', // Emerald
    '#8B5CF6', // Violet
    '#EF4444', // Red
    '#06B6D4', // Cyan
    '#F97316', // Orange
    '#84CC16', // Lime
    '#EC4899', // Pink
    '#6366F1', // Indigo
  ]
  return colors[idx % colors.length]
}
