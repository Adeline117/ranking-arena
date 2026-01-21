'use client'

import { useState, useRef, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../Base'

type TabKey = 'overview' | 'stats' | 'portfolio' | 'discussion'

interface TraderTabsProps {
  activeTab: TabKey
  onTabChange: (tab: TabKey) => void
  discussionCount?: number
}

export default function TraderTabs({ activeTab, onTabChange, discussionCount }: TraderTabsProps) {
  const { t, language } = useLanguage()
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 })
  const tabRefs = useRef<Map<TabKey, HTMLButtonElement>>(new Map())

  const tabs: Array<{ key: TabKey; label: string; badge?: number }> = [
    { key: 'overview', label: t('overview') },
    { key: 'stats', label: t('stats') },
    { key: 'portfolio', label: t('portfolio') },
    { key: 'discussion', label: language === 'zh' ? '讨论' : 'Discussion', badge: discussionCount },
  ]

  // 更新指示器位置
  useEffect(() => {
    const activeRef = tabRefs.current.get(activeTab)
    if (activeRef) {
      const rect = activeRef.getBoundingClientRect()
      const containerRect = activeRef.parentElement?.getBoundingClientRect()
      if (containerRect) {
        setIndicatorStyle({
          left: rect.left - containerRect.left,
          width: rect.width,
        })
      }
    }
  }, [activeTab])

  return (
    <Box
      className="profile-tabs"
      role="tablist"
      aria-label="交易员资料标签页"
      style={{
        display: 'flex',
        gap: tokens.spacing[2],
        marginBottom: tokens.spacing[4],
        position: 'relative',
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        paddingBottom: tokens.spacing[3],
      }}
    >
      {tabs.map((tab) => (
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
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
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
          {/* Badge for discussion count */}
          {tab.badge !== undefined && tab.badge > 0 && (
            <Box
              style={{
                background: activeTab === tab.key
                  ? `${tokens.colors.accent.primary}30`
                  : `${tokens.colors.text.tertiary}20`,
                padding: `2px ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.full,
                minWidth: 20,
                textAlign: 'center',
              }}
            >
              <Text
                size="xs"
                weight="bold"
                style={{
                  color: activeTab === tab.key
                    ? tokens.colors.accent.primary
                    : tokens.colors.text.tertiary,
                }}
              >
                {tab.badge > 99 ? '99+' : tab.badge}
              </Text>
            </Box>
          )}
        </button>
      ))}
      
      {/* 滑动指示器 */}
      <Box
        style={{
          position: 'absolute',
          bottom: 0,
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          height: 2,
          background: tokens.colors.accent.primary,
          borderRadius: '2px 2px 0 0',
          transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />
    </Box>
  )
}

