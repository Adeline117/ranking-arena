'use client'

import { memo, useMemo } from 'react'
import { TrendingUp, Users, Activity, Award } from 'lucide-react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { formatCompact } from '@/lib/utils/format'
import { Sparkline } from '../charts/Sparkline'

// ============================================
// 类型定义
// ============================================

interface StatItem {
  label: string
  value: string | number
  change?: number
  trend?: number[]
  icon: React.ReactNode
  color: string
}

interface StatsBarProps {
  totalTraders?: number
  averageRoi?: number
  topPerformer?: {
    handle: string
    roi: number
  }
  activeExchanges?: number
  loading?: boolean
}

// ============================================
// 单个统计卡片
// ============================================

function StatCard({
  stat,
  loading,
}: {
  stat: StatItem
  loading?: boolean
}) {
  if (loading) {
    return (
      <Box
        style={{
          padding: '12px 16px',
          borderRadius: 12,
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          minWidth: 140,
        }}
      >
        <Box
          className="skeleton"
          style={{
            width: 60,
            height: 12,
            borderRadius: 4,
            marginBottom: 8,
            backgroundImage: 'linear-gradient(90deg, var(--color-bg-tertiary) 0%, var(--color-bg-hover) 50%, var(--color-bg-tertiary) 100%)',
            backgroundSize: '200% 100%',
          }}
        />
        <Box
          className="skeleton"
          style={{
            width: 80,
            height: 20,
            borderRadius: 4,
            backgroundImage: 'linear-gradient(90deg, var(--color-bg-tertiary) 0%, var(--color-bg-hover) 50%, var(--color-bg-tertiary) 100%)',
            backgroundSize: '200% 100%',
          }}
        />
      </Box>
    )
  }

  return (
    <Box
      style={{
        padding: '12px 16px',
        borderRadius: 12,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        minWidth: 140,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        transition: 'all 0.2s ease',
      }}
    >
      {/* 图标 */}
      <Box
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: `${stat.color}15`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: stat.color,
          flexShrink: 0,
        }}
      >
        {stat.icon}
      </Box>

      {/* 内容 */}
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text
          size="xs"
          color="tertiary"
          style={{ marginBottom: 2 }}
        >
          {stat.label}
        </Text>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Text
            size="md"
            weight="bold"
            style={{ color: tokens.colors.text.primary }}
          >
            {stat.value}
          </Text>

          {/* 变化指示 */}
          {stat.change !== undefined && (
            <Text
              size="xs"
              style={{
                color: stat.change >= 0
                  ? (tokens.colors.accent?.success || '#2fe57d')
                  : (tokens.colors.accent?.error || '#ff7c7c'),
              }}
            >
              {stat.change >= 0 ? '+' : ''}{stat.change.toFixed(1)}%
            </Text>
          )}
        </Box>
      </Box>

      {/* 迷你趋势图 */}
      {stat.trend && stat.trend.length > 0 && (
        <Box style={{ flexShrink: 0 }}>
          <Sparkline
            data={stat.trend}
            width={50}
            height={24}
            showEndpoint={false}
            showFill={false}
            strokeWidth={1.5}
          />
        </Box>
      )}
    </Box>
  )
}

// ============================================
// 主组件
// ============================================

function StatsBarComponent({
  totalTraders = 0,
  averageRoi = 0,
  topPerformer,
  activeExchanges = 5,
  loading = false,
}: StatsBarProps) {
  const stats: StatItem[] = useMemo(() => [
    {
      label: '活跃交易员',
      value: formatCompact(totalTraders),
      icon: <Users size={18} />,
      color: tokens.colors.accent?.primary || '#8b6fa8',
      trend: [10, 12, 15, 14, 18, 20, 22],
    },
    {
      label: '平均 ROI',
      value: `${averageRoi.toFixed(1)}%`,
      change: averageRoi > 50 ? 12.5 : -5.2,
      icon: <TrendingUp size={18} />,
      color: averageRoi >= 0
        ? (tokens.colors.accent?.success || '#2fe57d')
        : (tokens.colors.accent?.error || '#ff7c7c'),
    },
    {
      label: '最佳表现',
      value: topPerformer?.handle || '—',
      icon: <Award size={18} />,
      color: '#ffd700',
    },
    {
      label: '数据源',
      value: `${activeExchanges} 交易所`,
      icon: <Activity size={18} />,
      color: tokens.colors.accent?.primary || '#8b6fa8',
    },
  ], [totalTraders, averageRoi, topPerformer, activeExchanges])

  return (
    <Box
      role="region"
      aria-label="市场概览"
      data-tour="stats-bar"
      style={{
        display: 'flex',
        gap: 12,
        overflowX: 'auto',
        paddingBottom: 4,
        marginBottom: 16,
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
      }}
    >
      {stats.map((stat, index) => (
        <StatCard key={index} stat={stat} loading={loading} />
      ))}
    </Box>
  )
}

export const StatsBar = memo(StatsBarComponent)
export default StatsBar
