'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import type { TraderStats } from '@/lib/data/trader'
import { useLanguage } from '../../utils/LanguageProvider'

interface PerformanceChartProps {
  monthlyData?: TraderStats['monthlyPerformance']
}

export default function PerformanceChart({ monthlyData }: PerformanceChartProps) {
  const { t } = useLanguage()
  const [selectedYear, setSelectedYear] = useState('Current Year')
  const [showTooltip, setShowTooltip] = useState(false)

  if (!monthlyData || monthlyData.length === 0) return null

  const maxValue = Math.max(...monthlyData.map((d) => Math.abs(d.value)), 1)

  return (
    <Box bg="secondary" p={6} radius="xl" border="primary">
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing[4],
          position: 'relative',
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black">
            {t('roiTrendTitle')}
          </Text>
          <Box
            style={{
              position: 'relative',
              cursor: 'help',
            }}
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            <Text size="xs" color="tertiary" style={{ fontSize: '12px' }}>
              ?
            </Text>
            {showTooltip && (
              <Box
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: tokens.spacing[2],
                  padding: tokens.spacing[2],
                  background: tokens.colors.bg.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  boxShadow: tokens.shadow.md,
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.secondary,
                  whiteSpace: 'nowrap',
                  zIndex: 1000,
                  maxWidth: '300px',
                }}
              >
                {t('roiTrendTooltip')}
              </Box>
            )}
          </Box>
        </Box>
        <select
          value={selectedYear}
          onChange={(e) => setSelectedYear(e.target.value)}
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            cursor: 'pointer',
          }}
        >
          <option>Current Year</option>
        </select>
      </Box>

      {/* Chart Area */}
      <Box
        style={{
          height: 300,
          position: 'relative',
          marginBottom: tokens.spacing[4],
        }}
      >
        {/* Y-axis labels */}
        <Box
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 40,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            paddingRight: tokens.spacing[2],
          }}
        >
          <Text size="xs" color="tertiary" style={{ textAlign: 'right' }}>
            {maxValue.toFixed(1)}%
          </Text>
          <Text size="xs" color="tertiary" style={{ textAlign: 'right' }}>
            0%
          </Text>
          <Text size="xs" color="tertiary" style={{ textAlign: 'right' }}>
            {-maxValue.toFixed(1)}%
          </Text>
        </Box>

        {/* Bars */}
        <Box
          style={{
            marginLeft: 50,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[1],
            paddingTop: tokens.spacing[2],
            paddingBottom: tokens.spacing[2],
          }}
        >
          {monthlyData.map((item, idx) => {
            const height = Math.abs((item.value / maxValue) * 100)
            const isPositive = item.value >= 0

            return (
              <Box
                key={idx}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: isPositive ? 'flex-end' : 'flex-start',
                  height: '100%',
                }}
              >
                <Box
                  style={{
                    width: '100%',
                    height: `${height}%`,
                    background: isPositive ? tokens.colors.accent.success : tokens.colors.accent.error,
                    borderRadius: tokens.radius.sm,
                    minHeight: 4,
                  }}
                />
                <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1], textAlign: 'center' }}>
                  {item.month.slice(0, 3)}
                </Text>
              </Box>
            )
          })}
        </Box>
      </Box>

      {/* Table */}
      <Box
        style={{
          overflowX: 'auto',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
          }}
        >
          <thead>
            <tr style={{ borderBottom: `1px solid ${tokens.colors.border.secondary}` }}>
              <th style={{ padding: tokens.spacing[2], textAlign: 'left', fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                Month
              </th>
              {monthlyData.map((item, idx) => (
                <th key={idx} style={{ padding: tokens.spacing[2], textAlign: 'center', fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                  {item.month.slice(0, 3)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm, fontWeight: tokens.typography.fontWeight.bold }}>
                2025
              </td>
              {monthlyData.map((item, idx) => (
                <td
                  key={idx}
                  style={{
                    padding: tokens.spacing[2],
                    textAlign: 'center',
                    fontSize: tokens.typography.fontSize.sm,
                    color: item.value >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                  }}
                >
                  {item.value >= 0 ? '+' : ''}
                  {item.value.toFixed(2)}%
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </Box>
    </Box>
  )
}

