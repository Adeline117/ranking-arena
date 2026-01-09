'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Utils/LanguageProvider'
import { Box, Text } from '../Base'

type TabKey = 'overview' | 'stats' | 'portfolio'

interface TraderTabsProps {
  activeTab: TabKey
  onTabChange: (tab: TabKey) => void
}

export default function TraderTabs({ activeTab, onTabChange }: TraderTabsProps) {
  const { t } = useLanguage()
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'overview', label: t('overview') },
    { key: 'stats', label: t('stats') },
    { key: 'portfolio', label: t('portfolio') },
  ]

  return (
    <Box
      className="profile-tabs"
      style={{
        display: 'flex',
        gap: tokens.spacing[6],
        marginBottom: tokens.spacing[6],
        paddingBottom: tokens.spacing[4],
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className="profile-tab-button"
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

