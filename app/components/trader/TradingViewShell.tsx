'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'

interface TradingViewShellProps {
  symbol?: string
  timeframe?: string
}

/**
 * Chart页面 - 克制设计
 * 默认只显示价格和进出场标记，所有技术指标默认关闭
 */
export default function TradingViewShell({ symbol, timeframe = '1Y' }: TradingViewShellProps) {
  const [selectedTimeframe, setSelectedTimeframe] = useState(timeframe)

  const timeframes = ['1D', '1W', '1M', '3M', '1Y', 'All']

  return (
    <Box bg="secondary" p={0} radius="none" border="none" style={{ overflow: 'hidden' }}>
      {/* Top Toolbar - 简化 */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'flex-start',
          alignItems: 'center',
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          {timeframes.map((tf) => (
            <button
              key={tf}
              onClick={() => setSelectedTimeframe(tf)}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${selectedTimeframe === tf ? tokens.colors.border.primary : tokens.colors.border.secondary}`,
                background: selectedTimeframe === tf ? tokens.colors.bg.tertiary : tokens.colors.bg.primary,
                color: selectedTimeframe === tf ? tokens.colors.text.primary : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                cursor: 'pointer',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {tf}
            </button>
          ))}
        </Box>
      </Box>

      {/* Main Chart Area - 简化，无左侧工具栏 */}
      <Box
        style={{
          height: 500,
          position: 'relative',
          background: tokens.colors.bg.primary,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <Box style={{ textAlign: 'center' }}>
          <Text size="base" color="tertiary" style={{ marginBottom: tokens.spacing[2], fontWeight: tokens.typography.fontWeight.normal }}>
            图表占位
          </Text>
          <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.normal }}>
            默认只显示价格和进出场标记
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
