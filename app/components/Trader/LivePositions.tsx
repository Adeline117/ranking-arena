'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import { useLanguage } from '../Providers/LanguageProvider'

interface LivePosition {
  id: string
  symbol: string
  direction: 'long' | 'short'
  size: number
  entryPrice: number
  markPrice: number
  pnl: number
  pnlPct: number
  leverage: number
  marginType: 'cross' | 'isolated'
  updatedAt: string
}

interface LivePositionsProps {
  handle: string
  autoRefresh?: boolean
  refreshInterval?: number // in milliseconds
}

/**
 * 实时持仓组件
 * 显示交易员当前持仓，支持自动刷新
 */
export default function LivePositions({
  handle,
  autoRefresh = true,
  refreshInterval = 30000, // 30秒
}: LivePositionsProps) {
  const { t } = useLanguage()
  const [positions, setPositions] = useState<LivePosition[]>([])
  const [totalPnl, setTotalPnl] = useState(0)
  const [totalPnlPct, setTotalPnlPct] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // 注入 pulse 动画样式
  useEffect(() => {
    if (typeof document === 'undefined') return
    const styleId = 'pulse-animation-style'
    if (document.getElementById(styleId)) return
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = '@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }'
    document.head.appendChild(style)
  }, [])

  const fetchPositions = useCallback(async () => {
    try {
      const response = await fetch(`/api/traders/${encodeURIComponent(handle)}/positions`)
      if (!response.ok) {
        throw new Error('Failed to fetch positions')
      }
      const data = await response.json()
      setPositions(data.positions || [])
      setTotalPnl(data.totalPnl || 0)
      setTotalPnlPct(data.totalPnlPct || 0)
      setLastUpdated(new Date())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [handle])

  useEffect(() => {
    fetchPositions()

    if (autoRefresh) {
      const interval = setInterval(fetchPositions, refreshInterval)
      return () => clearInterval(interval)
    }
  }, [fetchPositions, autoRefresh, refreshInterval])

  const formatPrice = (price: number) => {
    if (price >= 1000) {
      return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }
    return price.toFixed(price < 1 ? 6 : 4)
  }

  const formatPnl = (value: number) => {
    const prefix = value >= 0 ? '+' : ''
    if (Math.abs(value) >= 1000000) {
      return `${prefix}$${(value / 1000000).toFixed(2)}M`
    } else if (Math.abs(value) >= 1000) {
      return `${prefix}$${(value / 1000).toFixed(2)}K`
    }
    return `${prefix}$${value.toFixed(2)}`
  }

  if (loading) {
    return (
      <Box bg="secondary" p={4} radius="md">
        <Box style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
          <Text size="sm" weight="semibold" color="primary">
            {t('livePositions')}
          </Text>
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 100 }}>
          <Text size="sm" color="tertiary">Loading positions...</Text>
        </Box>
      </Box>
    )
  }

  if (error) {
    return (
      <Box bg="secondary" p={4} radius="md">
        <Box style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
          <Text size="sm" weight="semibold" color="primary">
            {t('livePositions')}
          </Text>
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 100 }}>
          <Text size="sm" style={{ color: tokens.colors.accent.error }}>{error}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box bg="secondary" p={4} radius="md">
      {/* Header */}
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="semibold" color="primary">
            {t('livePositions')}
          </Text>
          <Box
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: positions.length > 0 ? tokens.colors.accent.success : tokens.colors.text.tertiary,
              animation: positions.length > 0 ? 'pulse 2s infinite' : 'none',
            }}
          />
          <Text size="xs" color="tertiary">
            {positions.length} {positions.length === 1 ? 'position' : 'positions'}
          </Text>
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Box>
            <Text size="xs" color="tertiary">Total PnL</Text>
            <Text
              size="sm"
              weight="bold"
              style={{
                color: totalPnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
              }}
            >
              {formatPnl(totalPnl)} ({totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}%)
            </Text>
          </Box>
          {lastUpdated && (
            <Text size="xs" color="tertiary">
              Updated: {lastUpdated.toLocaleTimeString()}
            </Text>
          )}
        </Box>
      </Box>

      {/* Positions Table */}
      {positions.length > 0 ? (
        <Box style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headerCellStyle}>Symbol</th>
                <th style={headerCellStyle}>Side</th>
                <th style={headerCellStyle}>Size</th>
                <th style={headerCellStyle}>Entry</th>
                <th style={headerCellStyle}>Mark</th>
                <th style={headerCellStyle}>PnL</th>
                <th style={headerCellStyle}>Leverage</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={position.id} style={rowStyle}>
                  <td style={cellStyle}>
                    <Text size="sm" weight="semibold" color="primary">
                      {position.symbol}
                    </Text>
                  </td>
                  <td style={cellStyle}>
                    <Box
                      style={{
                        display: 'inline-flex',
                        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                        borderRadius: tokens.radius.sm,
                        background: position.direction === 'long'
                          ? 'rgba(34, 197, 94, 0.15)'
                          : 'rgba(239, 68, 68, 0.15)',
                      }}
                    >
                      <Text
                        size="xs"
                        weight="semibold"
                        style={{
                          color: position.direction === 'long'
                            ? tokens.colors.accent.success
                            : tokens.colors.accent.error,
                          textTransform: 'uppercase',
                        }}
                      >
                        {position.direction}
                      </Text>
                    </Box>
                  </td>
                  <td style={cellStyle}>
                    <Text size="sm" color="secondary">
                      {position.size.toFixed(2)}%
                    </Text>
                  </td>
                  <td style={cellStyle}>
                    <Text size="sm" color="secondary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                      ${formatPrice(position.entryPrice)}
                    </Text>
                  </td>
                  <td style={cellStyle}>
                    <Text size="sm" color="secondary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                      ${formatPrice(position.markPrice)}
                    </Text>
                  </td>
                  <td style={cellStyle}>
                    <Box>
                      <Text
                        size="sm"
                        weight="semibold"
                        style={{
                          color: position.pnl >= 0
                            ? tokens.colors.accent.success
                            : tokens.colors.accent.error,
                          fontFamily: tokens.typography.fontFamily.mono.join(', '),
                        }}
                      >
                        {formatPnl(position.pnl)}
                      </Text>
                      <Text
                        size="xs"
                        style={{
                          color: position.pnlPct >= 0
                            ? tokens.colors.accent.success
                            : tokens.colors.accent.error,
                        }}
                      >
                        ({position.pnlPct >= 0 ? '+' : ''}{position.pnlPct.toFixed(2)}%)
                      </Text>
                    </Box>
                  </td>
                  <td style={cellStyle}>
                    <Text size="sm" color="secondary">
                      {position.leverage}x
                    </Text>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      ) : (
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 100 }}>
          <Text size="sm" color="tertiary">No open positions</Text>
        </Box>
      )}
    </Box>
  )
}

// Table styles
const headerCellStyle: React.CSSProperties = {
  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
  textAlign: 'left',
  borderBottom: `1px solid ${tokens.colors.border.primary}`,
  fontSize: tokens.typography.fontSize.xs,
  fontWeight: tokens.typography.fontWeight.semibold,
  color: tokens.colors.text.tertiary,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
}

const cellStyle: React.CSSProperties = {
  padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
  borderBottom: `1px solid ${tokens.colors.border.primary}`,
  verticalAlign: 'middle',
}

const rowStyle: React.CSSProperties = {
  transition: 'background 0.15s ease',
}
