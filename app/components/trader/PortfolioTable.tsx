'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import type { PortfolioItem } from '@/lib/data/trader'

interface PortfolioTableProps {
  items: PortfolioItem[]
}

type SortField = 'market' | 'invested' | 'pnl' | 'value' | 'price'
type SortOrder = 'asc' | 'desc'

/**
 * Portfolio页面 - 严格展示，无操作按钮
 * 只显示：交易对、方向、入场价格、当前盈亏百分比
 */
export default function PortfolioTable({ items }: PortfolioTableProps) {
  const [sortField, setSortField] = useState<SortField>('invested')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null)

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortOrder('desc')
    }
  }

  const sortedItems = [...items].sort((a, b) => {
    let aVal: number
    let bVal: number

    switch (sortField) {
      case 'market':
        aVal = a.market.localeCompare(b.market)
        bVal = 0
        return sortOrder === 'asc' ? aVal : -aVal
      case 'invested':
        aVal = a.invested
        bVal = b.invested
        break
      case 'pnl':
        aVal = a.pnl
        bVal = b.pnl
        break
      case 'value':
        aVal = a.value
        bVal = b.value
        break
      case 'price':
        aVal = a.price
        bVal = b.price
        break
      default:
        return 0
    }

    return sortOrder === 'asc' ? aVal - bVal : bVal - aVal
  })

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
          <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.normal }}>
            Last updated: {new Date().toLocaleDateString('zh-CN')}
          </Text>
        </Box>

        <Box style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
            }}
          >
            <thead>
              <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                <th
                  style={{
                    padding: tokens.spacing[3],
                    textAlign: 'left',
                    fontSize: tokens.typography.fontSize.xs,
                    color: tokens.colors.text.tertiary,
                    fontWeight: tokens.typography.fontWeight.bold,
                    cursor: 'pointer',
                  }}
                  onClick={() => handleSort('market')}
                >
                  Market
                </th>
                <th
                  style={{
                    padding: tokens.spacing[3],
                    textAlign: 'left',
                    fontSize: tokens.typography.fontSize.xs,
                    color: tokens.colors.text.tertiary,
                    fontWeight: tokens.typography.fontWeight.bold,
                  }}
                >
                  Direction
                </th>
                <th
                  style={{
                    padding: tokens.spacing[3],
                    textAlign: 'right',
                    fontSize: tokens.typography.fontSize.xs,
                    color: tokens.colors.text.tertiary,
                    fontWeight: tokens.typography.fontWeight.bold,
                    cursor: 'pointer',
                  }}
                  onClick={() => handleSort('price')}
                >
                  Entry Price
                </th>
                <th
                  style={{
                    padding: tokens.spacing[3],
                    textAlign: 'right',
                    fontSize: tokens.typography.fontSize.xs,
                    color: tokens.colors.text.tertiary,
                    fontWeight: tokens.typography.fontWeight.bold,
                    cursor: 'pointer',
                  }}
                  onClick={() => handleSort('pnl')}
                >
                  P/L(%)
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item, idx) => (
                <tr
                  key={idx}
                  style={{
                    borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    cursor: selectedMarket === item.market ? 'default' : 'pointer',
                    background: selectedMarket === item.market ? tokens.colors.bg.tertiary : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (selectedMarket !== item.market) {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectedMarket !== item.market) {
                      e.currentTarget.style.background = 'transparent'
                    }
                  }}
                  onClick={() => setSelectedMarket(selectedMarket === item.market ? null : item.market)}
                >
                  <td style={{ padding: tokens.spacing[3] }}>
                    <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                      {item.market}
                    </Text>
                  </td>
                  <td style={{ padding: tokens.spacing[3] }}>
                    <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
                      {item.direction === 'long' ? 'Long' : 'Short'}
                    </Text>
                  </td>
                  <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                    <Text size="sm" weight="bold" style={{ color: tokens.colors.text.secondary }}>
                      ${item.price.toLocaleString()}
                    </Text>
                  </td>
                  <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                    <Text
                      size="sm"
                      weight="bold"
                      style={{
                        color: item.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                      }}
                    >
                      {item.pnl >= 0 ? '+' : ''}
                      {item.pnl.toFixed(2)}%
                    </Text>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      </Box>

      {/* Market Detail Drawer - 仅展示，无操作 */}
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
          <Box
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: tokens.spacing[4],
            }}
          >
            <Text size="lg" weight="black">
              {selectedMarket}
            </Text>
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
            详情占位（待实现）
          </Text>
        </Box>
      )}
    </>
  )
}
