'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'

type TabKey = 'overview' | 'stats' | 'portfolio' | 'chart'

interface TraderTabsProps {
  activeTab: TabKey
  onTabChange: (tab: TabKey) => void
}

export default function TraderTabs({ activeTab, onTabChange }: TraderTabsProps) {
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'overview', label: '概览' },
    { key: 'stats', label: '统计' },
    { key: 'portfolio', label: '投资组合' },
    { key: 'chart', label: '图表' },
  ]

  return (
    <Box
      style={{
        display: 'flex',
        gap: tokens.spacing[6],
        mb: 6,
        pb: 4,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onTabChange(tab.key)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            position: 'relative',
            paddingBottom: tokens.spacing[1],
          }}
        >
          <Text
            size="base"
            weight={activeTab === tab.key ? 'black' : 'bold'}
            color={activeTab === tab.key ? 'primary' : 'secondary'}
            style={{}}
          >
            {tab.label}
          </Text>
          {activeTab === tab.key && (
            <Box
              style={{
                position: 'absolute',
                bottom: -16,
                left: 0,
                right: 0,
                height: 2,
                background: tokens.colors.text.primary,
              }}
            />
          )}
        </button>
      ))}
    </Box>
  )
}

