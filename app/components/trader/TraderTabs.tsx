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
  const { t, language } = useLanguage()
  // 使用 useMemo 确保语言变化时重新计算
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'overview', label: t('overview') },
    { key: 'stats', label: t('stats') },
    { key: 'portfolio', label: t('portfolio') },
  ]

  return (
    <Box
      className="profile-tabs"
      role="tablist"
      aria-label="交易员资料标签页"
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
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onTabChange(tab.key)
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault()
              const currentIndex = tabs.findIndex((t) => t.key === activeTab)
              const direction = e.key === 'ArrowLeft' ? -1 : 1
              const newIndex = (currentIndex + direction + tabs.length) % tabs.length
              onTabChange(tabs[newIndex].key)
            }
          }}
          aria-label={tab.label}
          aria-selected={activeTab === tab.key}
          role="tab"
          tabIndex={activeTab === tab.key ? 0 : -1}
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

