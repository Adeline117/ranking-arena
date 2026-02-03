'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import useSWR from 'swr'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

// ============================================
// 类型定义
// ============================================

export type TimePeriod = '7D' | '30D' | '90D'

export interface HistoryDataPoint {
  date: string
  roi: number
  pnl?: number
  rank?: number
  arenaScore?: number
}

interface RoiHistoryChartProps {
  /** 平台名称 */
  platform: string
  /** 交易员 ID */
  traderId: string
  /** 初始时间段 */
  initialPeriod?: TimePeriod
  /** 图表高度 */
  height?: number
  /** 是否显示时间段选择器 */
  showPeriodSelector?: boolean
  /** 是否显示数据表格 */
  showDataTable?: boolean
  /** 外部传入的历史数据（可选） */
  externalData?: Record<TimePeriod, HistoryDataPoint[]>
  /** 数据类型：roi 或 arenaScore */
  dataType?: 'roi' | 'arenaScore'
}

// ============================================
// 数据获取
// ============================================

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

// ============================================
// 主组件
// ============================================

export default function RoiHistoryChart({
  platform,
  traderId,
  initialPeriod = '30D',
  height = 280,
  showPeriodSelector = true,
  showDataTable = false,
  externalData,
  dataType = 'roi',
}: RoiHistoryChartProps) {
  const { language, t } = useLanguage()
  const [period, setPeriod] = useState<TimePeriod>(initialPeriod)
  const [mounted, setMounted] = useState(false)
  const [hoveredPoint, setHoveredPoint] = useState<HistoryDataPoint | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    setMounted(true)
  }, [])
  
  // 如果没有外部数据，从 API 获取
  const shouldFetch = !externalData
  const { data: apiData, error, isLoading } = useSWR<{ history: Record<TimePeriod, HistoryDataPoint[]> }>(
    shouldFetch ? `/api/trader/${platform}/${traderId}/history?period=${period}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
    }
  )
  
  // 获取当前时间段的数据
  const currentData = useMemo(() => {
    if (externalData) {
      return externalData[period] || []
    }
    return apiData?.history?.[period] || []
  }, [externalData, apiData, period])
  
  const hasData = currentData.length > 0
  
  // 计算统计数据
  const stats = useMemo(() => {
    if (!hasData) return null
    
    const values = currentData.map(d => dataType === 'arenaScore' ? (d.arenaScore || 0) : d.roi)
    const firstValue = values[0]
    const lastValue = values[values.length - 1]
    const minValue = Math.min(...values)
    const maxValue = Math.max(...values)
    const change = lastValue - firstValue
    const changePercent = firstValue !== 0 ? (change / Math.abs(firstValue)) * 100 : 0
    
    return {
      current: lastValue,
      start: firstValue,
      min: minValue,
      max: maxValue,
      change,
      changePercent,
      isPositive: change >= 0,
    }
  }, [currentData, hasData, dataType])

  return (
    <Box
      className="roi-history-chart glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[5],
        boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {/* Header */}
      <Box style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: tokens.spacing[4],
      }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
            {dataType === 'arenaScore' 
              ? (language === 'zh' ? 'Arena Score 历史' : 'Arena Score History')
              : (language === 'zh' ? 'ROI 历史趋势' : 'ROI History')}
          </Text>
          
          {/* Stats Badge */}
          {stats && (
            <Box style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.full,
              background: stats.isPositive 
                ? `${tokens.colors.accent.success}15` 
                : `${tokens.colors.accent.error}15`,
              border: `1px solid ${stats.isPositive ? tokens.colors.accent.success : tokens.colors.accent.error}30`,
            }}>
              <Text 
                size="sm" 
                weight="bold"
                style={{ 
                  color: stats.isPositive ? tokens.colors.accent.success : tokens.colors.accent.error,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                }}
              >
                {stats.isPositive ? '+' : ''}{stats.change.toFixed(2)}{dataType === 'roi' ? '%' : ''}
              </Text>
            </Box>
          )}
        </Box>
        
        {/* Period Selector */}
        {showPeriodSelector && (
          <PeriodSelector value={period} onChange={setPeriod} />
        )}
      </Box>
      
      {/* Loading State */}
      {isLoading && (
        <Box style={{ 
          height, 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}>
          <Box style={{ textAlign: 'center' }}>
            <Box className="loading-spinner" style={{
              width: 32,
              height: 32,
              border: `3px solid ${tokens.colors.border.primary}`,
              borderTopColor: tokens.colors.accent.primary,
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              margin: '0 auto',
              marginBottom: tokens.spacing[3],
            }} />
            <Text size="sm" color="tertiary">
              {language === 'zh' ? '加载历史数据...' : 'Loading history...'}
            </Text>
          </Box>
        </Box>
      )}
      
      {/* Error State */}
      {error && !isLoading && (
        <Box style={{ 
          height, 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}>
          <Text size="sm" color="tertiary">
            {language === 'zh' ? '暂无历史数据' : 'No history data available'}
          </Text>
        </Box>
      )}
      
      {/* Chart */}
      {!isLoading && !error && hasData && (
        <>
          <Box ref={chartRef} style={{ height, position: 'relative' }}>
            <InteractiveLineChart 
              data={currentData} 
              dataType={dataType}
              height={height}
              onHover={setHoveredPoint}
              hoveredPoint={hoveredPoint}
            />
          </Box>
          
          {/* Hover Tooltip */}
          {hoveredPoint && (
            <Box style={{
              position: 'absolute',
              top: 60,
              right: tokens.spacing[4],
              background: tokens.colors.bg.primary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              padding: tokens.spacing[3],
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
              zIndex: 10,
            }}>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                {new Date(hoveredPoint.date).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
              </Text>
              <Text size="lg" weight="black" style={{ 
                color: (dataType === 'arenaScore' ? hoveredPoint.arenaScore || 0 : hoveredPoint.roi) >= 0 
                  ? tokens.colors.accent.success 
                  : tokens.colors.accent.error,
                fontFamily: tokens.typography.fontFamily.mono.join(', '),
              }}>
                {dataType === 'arenaScore' 
                  ? (hoveredPoint.arenaScore?.toFixed(1) || 'N/A')
                  : `${hoveredPoint.roi >= 0 ? '+' : ''}${hoveredPoint.roi.toFixed(2)}%`}
              </Text>
            </Box>
          )}
        </>
      )}
      
      {/* Empty State */}
      {!isLoading && !error && !hasData && (
        <Box style={{ 
          height, 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}>
          <Box style={{ textAlign: 'center' }}>
            <Text size="sm" color="tertiary">
              {language === 'zh' ? `暂无 ${period} 历史数据` : `No ${period} history data`}
            </Text>
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
              {language === 'zh' ? '数据将随时间积累' : 'Data will accumulate over time'}
            </Text>
          </Box>
        </Box>
      )}
      
      {/* Stats Summary */}
      {stats && hasData && (
        <Box style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(4, 1fr)', 
          gap: tokens.spacing[3],
          marginTop: tokens.spacing[4],
          paddingTop: tokens.spacing[4],
          borderTop: `1px solid ${tokens.colors.border.primary}40`,
        }}>
          <StatItem 
            label={language === 'zh' ? '起始' : 'Start'} 
            value={`${stats.start.toFixed(2)}${dataType === 'roi' ? '%' : ''}`}
          />
          <StatItem 
            label={language === 'zh' ? '当前' : 'Current'} 
            value={`${stats.current.toFixed(2)}${dataType === 'roi' ? '%' : ''}`}
            highlight
            isPositive={stats.current >= 0}
          />
          <StatItem 
            label={language === 'zh' ? '最低' : 'Low'} 
            value={`${stats.min.toFixed(2)}${dataType === 'roi' ? '%' : ''}`}
          />
          <StatItem 
            label={language === 'zh' ? '最高' : 'High'} 
            value={`${stats.max.toFixed(2)}${dataType === 'roi' ? '%' : ''}`}
          />
        </Box>
      )}
      
      {/* Data Table (Optional) */}
      {showDataTable && hasData && (
        <DataTable data={currentData} dataType={dataType} />
      )}
      
      {/* CSS for spinner animation */}
      <style jsx global>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </Box>
  )
}

// ============================================
// 子组件
// ============================================

function PeriodSelector({
  value,
  onChange,
}: {
  value: TimePeriod
  onChange: (v: TimePeriod) => void
}) {
  return (
    <Box
      style={{
        display: 'flex',
        gap: 2,
        background: tokens.colors.bg.tertiary,
        padding: 3,
        borderRadius: tokens.radius.lg,
      }}
    >
      {(['7D', '30D', '90D'] as const).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.md,
            border: 'none',
            background: value === p 
              ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
              : 'transparent',
            color: value === p ? '#fff' : tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: value === p ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
            cursor: 'pointer',
            transition: 'all 0.25s ease',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          {p}
        </button>
      ))}
    </Box>
  )
}

function StatItem({ 
  label, 
  value, 
  highlight = false,
  isPositive = true,
}: { 
  label: string
  value: string
  highlight?: boolean
  isPositive?: boolean
}) {
  return (
    <Box style={{ 
      textAlign: 'center',
      padding: tokens.spacing[2],
      background: highlight ? `${isPositive ? tokens.colors.accent.success : tokens.colors.accent.error}08` : 'transparent',
      borderRadius: tokens.radius.lg,
    }}>
      <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1], display: 'block' }}>
        {label}
      </Text>
      <Text 
        size="sm" 
        weight="bold" 
        style={{ 
          color: highlight 
            ? (isPositive ? tokens.colors.accent.success : tokens.colors.accent.error)
            : tokens.colors.text.primary,
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
        }}
      >
        {value}
      </Text>
    </Box>
  )
}

function InteractiveLineChart({ 
  data, 
  dataType,
  height,
  onHover,
  hoveredPoint,
}: { 
  data: HistoryDataPoint[]
  dataType: 'roi' | 'arenaScore'
  height: number
  onHover: (point: HistoryDataPoint | null) => void
  hoveredPoint: HistoryDataPoint | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  
  const values = data.map(d => dataType === 'arenaScore' ? (d.arenaScore || 0) : d.roi)
  const maxValue = Math.max(...values)
  const minValue = Math.min(...values)
  const range = maxValue - minValue || 1
  
  // 添加一些 padding
  const paddedMin = minValue - range * 0.1
  const paddedMax = maxValue + range * 0.1
  const paddedRange = paddedMax - paddedMin
  
  const chartWidth = 100
  const chartHeight = 100
  
  const points = data.map((d, i) => {
    const value = dataType === 'arenaScore' ? (d.arenaScore || 0) : d.roi
    const x = data.length > 1 ? (i / (data.length - 1)) * chartWidth : chartWidth / 2
    const y = chartHeight - ((value - paddedMin) / paddedRange) * chartHeight
    return { x, y, data: d }
  })
  
  const pathD = `M ${points.map(p => `${p.x},${p.y}`).join(' L ')}`
  
  const lastValue = values[values.length - 1]
  const firstValue = values[0]
  const isPositive = lastValue >= firstValue
  const color = isPositive ? tokens.colors.accent.success : tokens.colors.accent.error
  
  // 处理鼠标悬停
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!containerRef.current || data.length === 0) return
    
    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const ratio = x / rect.width
    const index = Math.round(ratio * (data.length - 1))
    const clampedIndex = Math.max(0, Math.min(data.length - 1, index))
    
    onHover(data[clampedIndex])
  }, [data, onHover])
  
  const handleMouseLeave = useCallback(() => {
    onHover(null)
  }, [onHover])
  
  // 找到悬停点的索引
  const hoveredIndex = hoveredPoint ? data.findIndex(d => d.date === hoveredPoint.date) : -1
  const hoveredPointCoords = hoveredIndex >= 0 ? points[hoveredIndex] : null

  return (
    <Box 
      ref={containerRef}
      style={{ 
        height: '100%', 
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}40 100%)`, 
        borderRadius: tokens.radius.xl,
        padding: tokens.spacing[4],
        position: 'relative',
        border: `1px solid ${tokens.colors.border.primary}40`,
        cursor: 'crosshair',
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
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
          {dataType === 'roi' ? `${paddedMax.toFixed(0)}%` : paddedMax.toFixed(0)}
        </Text>
        <Text size="xs" color="tertiary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
          {dataType === 'roi' ? `${((paddedMax + paddedMin) / 2).toFixed(0)}%` : ((paddedMax + paddedMin) / 2).toFixed(0)}
        </Text>
        <Text size="xs" color="tertiary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
          {dataType === 'roi' ? `${paddedMin.toFixed(0)}%` : paddedMin.toFixed(0)}
        </Text>
      </Box>
      
      {/* Chart Area */}
      <Box style={{ 
        marginLeft: 55, 
        height: 'calc(100% - 32px)',
        position: 'relative',
      }}>
        <svg 
          viewBox={`0 0 ${chartWidth} ${chartHeight}`} 
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%' }}
        >
          {/* Grid */}
          {[0, 25, 50, 75, 100].map(y => (
            <line 
              key={y} 
              x1="0" 
              y1={y} 
              x2="100" 
              y2={y} 
              stroke={tokens.colors.border.primary} 
              strokeWidth="0.3" 
              strokeDasharray="2,2" 
            />
          ))}
          
          {/* Zero Line (if visible) */}
          {paddedMin < 0 && paddedMax > 0 && (
            <line
              x1="0"
              y1={chartHeight - ((0 - paddedMin) / paddedRange) * chartHeight}
              x2="100"
              y2={chartHeight - ((0 - paddedMin) / paddedRange) * chartHeight}
              stroke={tokens.colors.text.tertiary}
              strokeWidth="0.5"
              strokeDasharray="4,4"
            />
          )}
          
          {/* Area Fill */}
          <path
            d={`${pathD} L ${chartWidth},${chartHeight} L 0,${chartHeight} Z`}
            fill={`url(#roi-gradient-${isPositive ? 'positive' : 'negative'})`}
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
          
          {/* Data Points on Hover */}
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={hoveredIndex === i ? 4 : 0}
              fill={color}
              stroke="#fff"
              strokeWidth="2"
              style={{ transition: 'r 0.15s ease' }}
            />
          ))}
          
          {/* Hover Line */}
          {hoveredPointCoords && (
            <line
              x1={hoveredPointCoords.x}
              y1="0"
              x2={hoveredPointCoords.x}
              y2="100"
              stroke={tokens.colors.text.tertiary}
              strokeWidth="0.5"
              strokeDasharray="3,3"
            />
          )}
          
          {/* Gradient Definitions */}
          <defs>
            <linearGradient id="roi-gradient-positive" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.colors.accent.success} stopOpacity="0.4" />
              <stop offset="100%" stopColor={tokens.colors.accent.success} stopOpacity="0" />
            </linearGradient>
            <linearGradient id="roi-gradient-negative" x1="0" y1="0" x2="0" y2="1">
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
        {data.length > 2 && (
          <Text size="xs" color="tertiary">
            {new Date(data[Math.floor(data.length / 2)].date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
          </Text>
        )}
        <Text size="xs" color="tertiary">
          {data[data.length - 1]?.date ? new Date(data[data.length - 1].date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}
        </Text>
      </Box>
    </Box>
  )
}

function DataTable({ 
  data, 
  dataType,
}: { 
  data: HistoryDataPoint[]
  dataType: 'roi' | 'arenaScore'
}) {
  const { language } = useLanguage()
  const [expanded, setExpanded] = useState(false)
  const displayData = expanded ? data : data.slice(-7)
  
  return (
    <Box style={{ marginTop: tokens.spacing[4] }}>
      <Box style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: tokens.spacing[3],
      }}>
        <Text size="sm" weight="bold" color="secondary">
          {language === 'zh' ? '历史数据' : 'Historical Data'}
        </Text>
        {data.length > 7 && (
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent',
              color: tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.xs,
              cursor: 'pointer',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {expanded ? (language === 'zh' ? '收起' : 'Collapse') : (language === 'zh' ? '展开全部' : 'Show All')}
          </button>
        )}
      </Box>
      
      <Box style={{ 
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.lg,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <Box style={{ 
          display: 'grid', 
          gridTemplateColumns: '1fr 1fr 1fr',
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          background: tokens.colors.bg.secondary,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <Text size="xs" weight="bold" color="tertiary">
            {language === 'zh' ? '日期' : 'Date'}
          </Text>
          <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right' }}>
            {dataType === 'arenaScore' ? 'Arena Score' : 'ROI'}
          </Text>
          {dataType === 'roi' && (
            <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right' }}>
              PnL
            </Text>
          )}
        </Box>
        
        {/* Rows */}
        {displayData.slice().reverse().map((item, idx) => {
          const value = dataType === 'arenaScore' ? (item.arenaScore || 0) : item.roi
          const isPositive = value >= 0
          
          return (
            <Box 
              key={idx}
              style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr 1fr',
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderBottom: idx < displayData.length - 1 ? `1px solid ${tokens.colors.border.primary}40` : 'none',
              }}
            >
              <Text size="xs" color="secondary">
                {new Date(item.date).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
              </Text>
              <Text 
                size="xs" 
                weight="bold"
                style={{ 
                  textAlign: 'right',
                  color: isPositive ? tokens.colors.accent.success : tokens.colors.accent.error,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                }}
              >
                {dataType === 'arenaScore' 
                  ? value.toFixed(1)
                  : `${isPositive ? '+' : ''}${value.toFixed(2)}%`}
              </Text>
              {dataType === 'roi' && (
                <Text 
                  size="xs"
                  style={{ 
                    textAlign: 'right',
                    color: (item.pnl || 0) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                    fontFamily: tokens.typography.fontFamily.mono.join(', '),
                  }}
                >
                  {item.pnl !== undefined ? `$${item.pnl.toLocaleString()}` : '--'}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
