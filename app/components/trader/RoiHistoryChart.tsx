'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import useSWR from 'swr'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { Skeleton } from '../ui/Skeleton'
import dynamic from 'next/dynamic'
import type { Time } from 'lightweight-charts'

const TradingViewChart = dynamic(() => import('../charts/TradingViewChart'), { ssr: false })
type LineDataPoint = import('../charts/TradingViewChart').LineDataPoint

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
  const { language } = useLanguage()
  const [period, setPeriod] = useState<TimePeriod>(initialPeriod)
  const [mounted, setMounted] = useState(false)
  const [_hoveredPoint, _setHoveredPoint] = useState<HistoryDataPoint | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    setMounted(true)
  }, [])
  
  // Handle ESC key to exit fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false)
      }
    }
    if (isFullscreen) {
      document.addEventListener('keydown', handleKeyDown)
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [isFullscreen])
  
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

  // Convert data for TradingView chart
  const tvChartData = useMemo<LineDataPoint[]>(() => {
    return currentData.map(d => ({
      time: d.date as Time,
      value: dataType === 'arenaScore' ? (d.arenaScore || 0) : d.roi,
    }))
  }, [currentData, dataType])

  // Detect current theme
  const currentTheme = useMemo<'dark' | 'light'>(() => {
    if (typeof document !== 'undefined') {
      const t = document.documentElement.getAttribute('data-theme')
      return t === 'light' ? 'light' : 'dark'
    }
    return 'dark'
  }, [])

  const fullscreenStyles = isFullscreen ? {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    borderRadius: 0,
    padding: tokens.spacing[6],
    background: tokens.colors.bg.primary,
  } : {}

  // Show skeleton during loading
  if (isLoading && shouldFetch) {
    return (
      <div
        className="roi-history-chart glass-card"
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}60`,
          padding: tokens.spacing[5],
          boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08)`,
        }}
      >
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
          <Skeleton width={150} height={24} />
          <Skeleton width={200} height={32} />
        </Box>
        <Skeleton width="100%" height={height} style={{ borderRadius: tokens.radius.lg }} />
      </div>
    )
  }

  return (
    <div
      className="roi-history-chart glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[5],
        boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        ...fullscreenStyles,
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
        
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {/* Period Selector */}
          {showPeriodSelector && (
            <PeriodSelector value={period} onChange={setPeriod} />
          )}
          
          {/* Fullscreen Toggle Button */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            title={isFullscreen ? (language === 'zh' ? '退出全屏' : 'Exit Fullscreen') : (language === 'zh' ? '全屏' : 'Fullscreen')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.tertiary,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.secondary
              e.currentTarget.style.borderColor = tokens.colors.accent.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.tertiary
              e.currentTarget.style.borderColor = tokens.colors.border.primary
            }}
          >
            {isFullscreen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.secondary} strokeWidth="2">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.secondary} strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            )}
          </button>
        </Box>
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
          <div ref={chartRef} style={{ height: isFullscreen ? 'calc(100vh - 200px)' : height, position: 'relative' }}>
            <TradingViewChart
              data={tvChartData}
              type="area"
              height={isFullscreen ? undefined : height}
              theme={currentTheme}
              locale={language as 'zh' | 'en'}
              color={stats?.isPositive ? undefined : undefined}
            />
          </div>
          
          {/* Tooltip handled by TradingView chart */}
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
    </div>
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
