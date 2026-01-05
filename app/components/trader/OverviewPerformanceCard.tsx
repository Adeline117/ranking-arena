'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import type { TraderPerformance } from '@/lib/data/trader'

interface OverviewPerformanceCardProps {
  performance: TraderPerformance
  profitableWeeksPct?: number
}

type Period = '90D' | '7D' | '30D' | '1Y' | '2Y' | 'All'

/**
 * Performance卡片 - 交易员主页核心指标
 * ROI视觉权重最高，其他指标中性色
 * 时间选择弱化，默认90天
 */
export default function OverviewPerformanceCard({ performance, profitableWeeksPct }: OverviewPerformanceCardProps) {
  const [period, setPeriod] = useState<Period>('90D')

  const getROI = () => {
    switch (period) {
      case '7D':
        return performance.roi_7d || 0
      case '30D':
        return performance.roi_30d || 0
      case '90D':
        return performance.roi_90d || 0
      case '1Y':
        return performance.roi_1y || 0
      case '2Y':
        return performance.roi_2y || 0
      default:
        return performance.roi_90d || 0
    }
  }

  const roi = getROI()

  return (
    <Box bg="secondary" p={6} radius="none" border="none">
      {/* Header - 最小化 */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: tokens.spacing[8],
        }}
      >
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          Performance
        </Text>
        {/* 时间选择 - 弱化，放在小下拉菜单 */}
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.xs,
            cursor: 'pointer',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          <option value="90D">90D</option>
          <option value="7D">7D</option>
          <option value="30D">30D</option>
          <option value="1Y">1Y</option>
          <option value="2Y">2Y</option>
          <option value="All">All</option>
        </select>
      </Box>

      {/* ROI Display - 视觉权重最高 */}
      <Box style={{ marginBottom: tokens.spacing[8] }}>
        <Text
          size="3xl"
          weight="black"
          style={{
            color: roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
            lineHeight: 1.1,
            marginBottom: tokens.spacing[2],
            letterSpacing: '-0.02em',
          }}
        >
          {roi >= 0 ? '+' : ''}
          {roi.toFixed(2)}%
        </Text>
        <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.normal }}>
          ROI ({period})
        </Text>
      </Box>

      {/* 辅助指标 - 中性色，视觉权重低 */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: tokens.spacing[4],
          paddingTop: tokens.spacing[4],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              Return YTD
            </Text>
            <InfoIcon tooltip="年初至今的收益率，反映交易员今年的整体表现" />
          </Box>
          <Text size="base" weight="bold" style={{ color: tokens.colors.text.secondary }}>
            {performance.return_ytd ? (performance.return_ytd >= 0 ? '+' : '') + performance.return_ytd.toFixed(2) + '%' : 'N/A'}
          </Text>
        </Box>
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              Return 2Y
            </Text>
            <InfoIcon tooltip="过去两年的收益率，反映交易员的长期盈利能力" />
          </Box>
          <Text size="base" weight="bold" style={{ color: tokens.colors.text.secondary }}>
            {performance.return_2y ? (performance.return_2y >= 0 ? '+' : '') + performance.return_2y.toFixed(2) + '%' : 'N/A'}
          </Text>
        </Box>
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              Profitable Weeks
            </Text>
            <InfoIcon tooltip="盈利周数占总周数的百分比，反映交易员盈利能力的稳定性" />
          </Box>
          <Text size="base" weight="bold" style={{ color: tokens.colors.text.secondary }}>
            {profitableWeeksPct !== undefined ? `${profitableWeeksPct.toFixed(2)}%` : 'N/A'}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

// Info Icon Component
function InfoIcon({ tooltip }: { tooltip: string }) {
  const [showTooltip, setShowTooltip] = useState(false)

  return (
    <Box
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <Box
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: `1px solid ${tokens.colors.text.tertiary}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'help',
          fontSize: '10px',
          color: tokens.colors.text.tertiary,
          flexShrink: 0,
        }}
      >
        i
      </Box>
      {showTooltip && (
        <Box
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: tokens.spacing[1],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            background: tokens.colors.bg.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.primary,
            whiteSpace: 'nowrap',
            zIndex: 1000,
            pointerEvents: 'none',
            maxWidth: 200,
            whiteSpace: 'normal',
            textAlign: 'center',
          }}
        >
          {tooltip}
        </Box>
      )}
    </Box>
  )
}
