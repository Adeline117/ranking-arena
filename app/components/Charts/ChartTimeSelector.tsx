'use client'

import { tokens } from '@/lib/design-tokens'

export type ChartTimeRange = '7d' | '30d' | '90d' | '180d' | '1y' | 'all'

interface ChartTimeSelectorProps {
  value: ChartTimeRange
  onChange: (range: ChartTimeRange) => void
  disabled?: boolean
  size?: 'sm' | 'md'
}

const RANGES: { value: ChartTimeRange; label: string }[] = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: '180d', label: '180D' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'ALL' },
]

/**
 * 图表时间范围选择器
 * 用于切换图表显示的时间范围
 */
export function ChartTimeSelector({
  value,
  onChange,
  disabled = false,
  size = 'sm',
}: ChartTimeSelectorProps) {
  const padding = size === 'sm' ? '4px 8px' : '6px 12px'
  const fontSize = size === 'sm' ? 11 : 12

  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        padding: 3,
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.md,
      }}
    >
      {RANGES.map((range) => {
        const isActive = value === range.value
        return (
          <button
            key={range.value}
            onClick={() => onChange(range.value)}
            disabled={disabled}
            style={{
              padding,
              fontSize,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? tokens.colors.text.primary : tokens.colors.text.tertiary,
              background: isActive ? tokens.colors.bg.secondary : 'transparent',
              border: 'none',
              borderRadius: tokens.radius.sm,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition: 'all 0.15s ease',
            }}
          >
            {range.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 图表类型切换器
 */
export type ChartType = 'line' | 'bar' | 'area' | 'candle'

interface ChartTypeSelectorProps {
  value: ChartType
  onChange: (type: ChartType) => void
  disabled?: boolean
  types?: ChartType[]
}

const TYPE_ICONS: Record<ChartType, string> = {
  line: '📈',
  bar: '📊',
  area: '📉',
  candle: '🕯️',
}

export function ChartTypeSelector({
  value,
  onChange,
  disabled = false,
  types = ['line', 'area', 'bar'],
}: ChartTypeSelectorProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        padding: 3,
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.md,
      }}
    >
      {types.map((type) => {
        const isActive = value === type
        return (
          <button
            key={type}
            onClick={() => onChange(type)}
            disabled={disabled}
            title={type.charAt(0).toUpperCase() + type.slice(1)}
            style={{
              padding: '4px 8px',
              fontSize: 14,
              background: isActive ? tokens.colors.bg.secondary : 'transparent',
              border: 'none',
              borderRadius: tokens.radius.sm,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition: 'all 0.15s ease',
            }}
          >
            {TYPE_ICONS[type]}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 图表工具栏
 * 组合时间选择器和类型选择器
 */
interface ChartToolbarProps {
  timeRange: ChartTimeRange
  onTimeRangeChange: (range: ChartTimeRange) => void
  chartType?: ChartType
  onChartTypeChange?: (type: ChartType) => void
  showChartType?: boolean
  disabled?: boolean
  children?: React.ReactNode
}

export function ChartToolbar({
  timeRange,
  onTimeRangeChange,
  chartType = 'line',
  onChartTypeChange,
  showChartType = false,
  disabled = false,
  children,
}: ChartToolbarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacing[3],
        marginBottom: tokens.spacing[3],
        flexWrap: 'wrap',
      }}
    >
      <ChartTimeSelector
        value={timeRange}
        onChange={onTimeRangeChange}
        disabled={disabled}
      />
      
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        {showChartType && onChartTypeChange && (
          <ChartTypeSelector
            value={chartType}
            onChange={onChartTypeChange}
            disabled={disabled}
          />
        )}
        {children}
      </div>
    </div>
  )
}

export default ChartTimeSelector
