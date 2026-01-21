'use client'

import { memo, useMemo } from 'react'

// ============================================
// 类型定义
// ============================================

interface SparklineProps {
  /** 数据点数组 */
  data: number[]
  /** 图表宽度 */
  width?: number
  /** 图表高度 */
  height?: number
  /** 线条颜色（默认根据趋势自动选择） */
  color?: string
  /** 正趋势颜色 */
  positiveColor?: string
  /** 负趋势颜色 */
  negativeColor?: string
  /** 中性颜色 */
  neutralColor?: string
  /** 线条粗细 */
  strokeWidth?: number
  /** 是否显示填充区域 */
  showFill?: boolean
  /** 填充透明度 */
  fillOpacity?: number
  /** 是否显示端点 */
  showEndpoint?: boolean
  /** 是否显示参考线（零线） */
  showReferenceLine?: boolean
  /** 是否使用平滑曲线 */
  smooth?: boolean
  /** 自定义类名 */
  className?: string
  /** aria-label */
  ariaLabel?: string
}

// ============================================
// 辅助函数
// ============================================

/**
 * 将数据点转换为 SVG 路径
 */
function dataToPath(
  data: number[],
  width: number,
  height: number,
  smooth: boolean
): string {
  if (data.length === 0) return ''
  if (data.length === 1) {
    const y = height / 2
    return `M 0,${y} L ${width},${y}`
  }

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const xStep = width / (data.length - 1)
  const padding = 2

  const points = data.map((value, index) => ({
    x: index * xStep,
    y: padding + ((max - value) / range) * (height - padding * 2),
  }))

  if (smooth && points.length > 2) {
    // 使用 Catmull-Rom 样条曲线创建平滑路径
    return createSmoothPath(points)
  }

  // 直线连接
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ')
}

/**
 * 创建平滑的贝塞尔曲线路径
 */
function createSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return ''

  let path = `M ${points[0].x},${points[0].y}`

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? i : i - 1]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1]

    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6

    path += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`
  }

  return path
}

/**
 * 创建填充区域路径
 */
function createFillPath(linePath: string, width: number, height: number): string {
  return `${linePath} L ${width},${height} L 0,${height} Z`
}

/**
 * 判断趋势方向
 */
function getTrend(data: number[]): 'positive' | 'negative' | 'neutral' {
  if (data.length < 2) return 'neutral'

  const first = data[0]
  const last = data[data.length - 1]
  const change = ((last - first) / Math.abs(first || 1)) * 100

  if (change > 1) return 'positive'
  if (change < -1) return 'negative'
  return 'neutral'
}

// ============================================
// 主组件
// ============================================

function SparklineComponent({
  data,
  width = 80,
  height = 24,
  color,
  positiveColor = '#2fe57d',
  negativeColor = '#ff7c7c',
  neutralColor = '#8a8a9a',
  strokeWidth = 1.5,
  showFill = true,
  fillOpacity = 0.15,
  showEndpoint = true,
  showReferenceLine = false,
  smooth = true,
  className,
  ariaLabel,
}: SparklineProps) {
  // 计算路径和颜色
  const { linePath, fillPath, lineColor, trend, endpointY } = useMemo(() => {
    const trend = getTrend(data)
    const lineColor = color || (
      trend === 'positive' ? positiveColor :
      trend === 'negative' ? negativeColor :
      neutralColor
    )

    const linePath = dataToPath(data, width, height, smooth)
    const fillPath = showFill ? createFillPath(linePath, width, height) : ''

    // 计算端点位置
    let endpointY = height / 2
    if (data.length > 0) {
      const min = Math.min(...data)
      const max = Math.max(...data)
      const range = max - min || 1
      const padding = 2
      endpointY = padding + ((max - data[data.length - 1]) / range) * (height - padding * 2)
    }

    return { linePath, fillPath, lineColor, trend, endpointY }
  }, [data, width, height, color, positiveColor, negativeColor, neutralColor, smooth, showFill])

  // 空数据处理
  if (data.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        className={className}
        role="img"
        aria-label={ariaLabel || '暂无数据'}
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={neutralColor}
          strokeWidth={strokeWidth}
          strokeDasharray="4 2"
          opacity={0.3}
        />
      </svg>
    )
  }

  // 计算趋势描述
  const trendDescription = useMemo(() => {
    if (data.length < 2) return '数据不足'
    const first = data[0]
    const last = data[data.length - 1]
    const change = ((last - first) / Math.abs(first || 1)) * 100
    return `趋势${change >= 0 ? '上涨' : '下跌'} ${Math.abs(change).toFixed(1)}%`
  }, [data])

  return (
    <svg
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={ariaLabel || trendDescription}
      style={{ overflow: 'visible' }}
    >
      {/* 参考线（零线） */}
      {showReferenceLine && (
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={neutralColor}
          strokeWidth={0.5}
          strokeDasharray="2 2"
          opacity={0.3}
        />
      )}

      {/* 填充区域 */}
      {showFill && fillPath && (
        <path
          d={fillPath}
          fill={lineColor}
          opacity={fillOpacity}
        />
      )}

      {/* 主线条 */}
      <path
        d={linePath}
        fill="none"
        stroke={lineColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* 端点 */}
      {showEndpoint && data.length > 0 && (
        <>
          {/* 外圈光晕 */}
          <circle
            cx={width}
            cy={endpointY}
            r={4}
            fill={lineColor}
            opacity={0.2}
          />
          {/* 内圈实心 */}
          <circle
            cx={width}
            cy={endpointY}
            r={2}
            fill={lineColor}
          />
        </>
      )}
    </svg>
  )
}

export const Sparkline = memo(SparklineComponent)

// ============================================
// 趋势指示器组件
// ============================================

interface TrendIndicatorProps {
  value: number
  previousValue?: number
  showValue?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

function TrendIndicatorComponent({
  value,
  previousValue,
  showValue = true,
  size = 'md',
  className,
}: TrendIndicatorProps) {
  const change = previousValue != null
    ? ((value - previousValue) / Math.abs(previousValue || 1)) * 100
    : value

  const isPositive = change > 0
  const isNegative = change < 0
  const isNeutral = change === 0

  const color = isPositive
    ? '#2fe57d'
    : isNegative
      ? '#ff7c7c'
      : '#8a8a9a'

  const sizes = {
    sm: { icon: 12, text: 11 },
    md: { icon: 14, text: 12 },
    lg: { icon: 16, text: 14 },
  }

  const s = sizes[size]

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        color,
      }}
      role="status"
      aria-label={`${isPositive ? '上涨' : isNegative ? '下跌' : '持平'} ${Math.abs(change).toFixed(1)}%`}
    >
      {/* 箭头图标 */}
      <svg
        width={s.icon}
        height={s.icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          transform: isNeutral ? 'rotate(0deg)' : isPositive ? 'rotate(0deg)' : 'rotate(180deg)',
        }}
      >
        {isNeutral ? (
          <line x1="5" y1="12" x2="19" y2="12" />
        ) : (
          <>
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </>
        )}
      </svg>

      {/* 数值 */}
      {showValue && (
        <span style={{ fontSize: s.text, fontWeight: 600 }}>
          {Math.abs(change).toFixed(1)}%
        </span>
      )}
    </span>
  )
}

export const TrendIndicator = memo(TrendIndicatorComponent)

// ============================================
// 迷你柱状图组件
// ============================================

interface MiniBarChartProps {
  data: number[]
  width?: number
  height?: number
  positiveColor?: string
  negativeColor?: string
  gap?: number
  className?: string
  ariaLabel?: string
}

function MiniBarChartComponent({
  data,
  width = 60,
  height = 20,
  positiveColor = '#2fe57d',
  negativeColor = '#ff7c7c',
  gap = 1,
  className,
  ariaLabel,
}: MiniBarChartProps) {
  if (data.length === 0) {
    return (
      <svg width={width} height={height} className={className}>
        <text
          x={width / 2}
          y={height / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#8a8a9a"
          fontSize={10}
        >
          —
        </text>
      </svg>
    )
  }

  const max = Math.max(...data.map(Math.abs))
  const barWidth = (width - (data.length - 1) * gap) / data.length
  const centerY = height / 2

  return (
    <svg
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={ariaLabel || `柱状图，${data.length} 个数据点`}
    >
      {/* 零线 */}
      <line
        x1={0}
        y1={centerY}
        x2={width}
        y2={centerY}
        stroke="#3a3848"
        strokeWidth={0.5}
      />

      {/* 柱子 */}
      {data.map((value, index) => {
        const barHeight = max > 0 ? (Math.abs(value) / max) * (height / 2 - 1) : 0
        const isPositive = value >= 0
        const x = index * (barWidth + gap)
        const y = isPositive ? centerY - barHeight : centerY

        return (
          <rect
            key={index}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            fill={isPositive ? positiveColor : negativeColor}
            rx={1}
            opacity={0.8 + (index / data.length) * 0.2}
          />
        )
      })}
    </svg>
  )
}

export const MiniBarChart = memo(MiniBarChartComponent)

export default Sparkline
