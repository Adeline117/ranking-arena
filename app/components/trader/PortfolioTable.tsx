'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import type { PortfolioItem, PositionHistoryItem } from '@/lib/data/trader'

interface PortfolioTableProps {
  items: PortfolioItem[]
  history?: PositionHistoryItem[]
}

type ViewMode = 'current' | 'history'

/**
 * Portfolio页面 - 显示当前持仓和历史仓位
 */
export default function PortfolioTable({ items, history = [] }: PortfolioTableProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('current')
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null)

  return (
    <>
      <Box bg="secondary" p={6} radius="none" border="none">
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.spacing[6],
          }}
        >
          <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
            Portfolio
          </Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
            <button
              onClick={() => setViewMode('current')}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${viewMode === 'current' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                background: viewMode === 'current' ? tokens.colors.accent.primary : 'transparent',
                color: viewMode === 'current' ? '#fff' : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.bold,
                cursor: 'pointer',
              }}
            >
              Current
            </button>
            <button
              onClick={() => setViewMode('history')}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${viewMode === 'history' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                background: viewMode === 'history' ? tokens.colors.accent.primary : 'transparent',
                color: viewMode === 'history' ? '#fff' : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.bold,
                cursor: 'pointer',
              }}
            >
              History
            </button>
          </Box>
        </Box>

        {viewMode === 'current' ? (
          // Current Holdings
          items.length > 0 ? (
            <Box style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                    <th style={{ ...thStyle, textAlign: 'left' }}>Market</th>
                    <th style={{ ...thStyle, textAlign: 'left' }}>Direction</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Weight %</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>P/L (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => (
                    <tr
                      key={idx}
                      style={{
                        borderBottom: `1px solid ${tokens.colors.border.primary}`,
                        cursor: 'pointer',
                        background: selectedMarket === item.market ? tokens.colors.bg.tertiary : 'transparent',
                      }}
                      onClick={() => setSelectedMarket(selectedMarket === item.market ? null : item.market)}
                    >
                      <td style={{ padding: tokens.spacing[3] }}>
                        <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                          {item.market}
                        </Text>
                      </td>
                      <td style={{ padding: tokens.spacing[3] }}>
                        <Text size="sm" style={{ 
                          color: item.direction === 'long' ? tokens.colors.accent.success : tokens.colors.accent.error 
                        }}>
                          {item.direction === 'long' ? 'Long' : 'Short'}
                        </Text>
                      </td>
                      <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                        <Text size="sm" weight="bold" style={{ color: tokens.colors.text.secondary }}>
                          {item.invested.toFixed(1)}%
                        </Text>
                      </td>
                      <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                        <Text
                          size="sm"
                          weight="bold"
                          style={{ color: item.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}
                        >
                          {item.pnl >= 0 ? '+' : ''}{item.pnl.toFixed(2)}%
                        </Text>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
          ) : (
            <EmptyState message="当前持仓数据暂不可用" subMessage="交易员目前可能没有公开持仓" />
          )
        ) : (
          // Position History
          history.length > 0 ? (
            <Box style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                    <th style={{ ...thStyle, textAlign: 'left' }}>Symbol</th>
                    <th style={{ ...thStyle, textAlign: 'left' }}>Direction</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Entry</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Exit</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>P/L</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item, idx) => (
                    <tr
                      key={idx}
                      style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}
                    >
                      <td style={{ padding: tokens.spacing[3] }}>
                        <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                          {item.symbol}
                        </Text>
                      </td>
                      <td style={{ padding: tokens.spacing[3] }}>
                        <Text size="sm" style={{ 
                          color: item.direction === 'long' ? tokens.colors.accent.success : tokens.colors.accent.error 
                        }}>
                          {item.direction === 'long' ? 'Long' : 'Short'}
                        </Text>
                      </td>
                      <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                        <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
                          ${item.entryPrice.toLocaleString()}
                        </Text>
                      </td>
                      <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                        <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
                          ${item.exitPrice.toLocaleString()}
                        </Text>
                      </td>
                      <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                        <Text
                          size="sm"
                          weight="bold"
                          style={{ color: item.pnlPct >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}
                        >
                          {item.pnlPct >= 0 ? '+' : ''}{item.pnlPct.toFixed(2)}%
                        </Text>
                      </td>
                      <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                        <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                          {item.closeTime ? new Date(item.closeTime).toLocaleDateString() : '-'}
                        </Text>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
          ) : (
            <EmptyState message="历史仓位数据暂不可用" subMessage="Position History 数据将在下次数据同步后显示" />
          )
        )}
      </Box>

      {/* Market Detail Drawer */}
      {selectedMarket && (
        <Box
          style={{
            position: 'fixed',
            right: 0,
            top: 0,
            bottom: 0,
            width: 400,
            background: tokens.colors.bg.primary,
            borderLeft: `1px solid ${tokens.colors.border.primary}`,
            padding: tokens.spacing[6],
            zIndex: 1000,
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
            <Text size="lg" weight="black">{selectedMarket}</Text>
            <button
              onClick={() => setSelectedMarket(null)}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xl,
              }}
            >
              ×
            </button>
          </Box>
          <Text size="sm" color="secondary">
            详细数据加载中...
          </Text>
        </Box>
      )}
    </>
  )
}

const thStyle = {
  padding: tokens.spacing[3],
  fontSize: tokens.typography.fontSize.xs,
  color: tokens.colors.text.tertiary,
  fontWeight: tokens.typography.fontWeight.bold,
}

function EmptyState({ message, subMessage }: { message: string; subMessage: string }) {
  return (
    <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
      <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
        {message}
      </Text>
      <Text size="xs" color="tertiary">
        {subMessage}
      </Text>
    </Box>
  )
}
