'use client'

import { useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'

type TabKey = 'overview' | 'stats' | 'portfolio'

interface TraderTabsProps {
  activeTab: TabKey
  onTabChange: (tab: TabKey) => void
  isPro?: boolean
  onProRequired?: () => void
}

export default function TraderTabs({ activeTab, onTabChange, isPro = false, onProRequired: _onProRequired }: TraderTabsProps) {
  const { t } = useLanguage()
  const tabRefs = useRef<Map<TabKey, HTMLButtonElement>>(new Map())

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
        gap: tokens.spacing[1],
        marginBottom: tokens.spacing[5],
        position: 'relative',
        padding: `${tokens.spacing[2]} ${tokens.spacing[2]}`,
        paddingBottom: tokens.spacing[2],
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        borderBottom: `1px solid ${tokens.colors.border.primary}40`,
      }}
    >
      {tabs.map((tab) => {
        const isProTab = tab.key === 'stats' || tab.key === 'portfolio'
        const showProBadge = !isPro && isProTab
        return (
          <button
            key={tab.key}
            ref={(el) => { if (el) tabRefs.current.set(tab.key, el) }}
            className="profile-tab-button interactive-scale"
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
              background: activeTab === tab.key
                ? `linear-gradient(135deg, ${tokens.colors.accent.primary}15, ${tokens.colors.accent.primary}08)`
                : 'transparent',
              border: activeTab === tab.key
                ? `1px solid ${tokens.colors.accent.primary}30`
                : '1px solid transparent',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              minHeight: 44,
              cursor: 'pointer',
              position: 'relative',
              borderRadius: tokens.radius.lg,
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
            }}
            onMouseEnter={(e) => {
              if (activeTab !== tab.key) {
                e.currentTarget.style.background = `${tokens.colors.bg.tertiary}80`
                e.currentTarget.style.transform = 'translateY(-2px)'
              }
            }}
            onMouseLeave={(e) => {
              if (activeTab !== tab.key) {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.transform = 'translateY(0)'
              }
            }}
          >
            <Text
              size="sm"
              weight={activeTab === tab.key ? 'black' : 'medium'}
              style={{
                color: activeTab === tab.key ? tokens.colors.text.primary : tokens.colors.text.secondary,
                transition: 'color 0.3s ease',
              }}
            >
              {tab.label}
            </Text>
            {showProBadge && (
              <Box style={{
                padding: '1px 6px',
                borderRadius: tokens.radius.sm,
                background: `linear-gradient(135deg, ${tokens.colors.accent.primary}25, ${tokens.colors.accent.brand}15)`,
                border: `1px solid ${tokens.colors.accent.primary}30`,
              }}>
                <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, fontSize: 9 }}>
                  PRO
                </Text>
              </Box>
            )}
          </button>
        )
      })}
    </Box>
  )
}

