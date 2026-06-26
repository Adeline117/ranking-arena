'use client'

import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

import type { ProfileTabKey } from './types'

interface UserProfileTabsProps {
  activeTab: ProfileTabKey
  onTabChange: (tab: ProfileTabKey) => void
}

export default function UserProfileTabs({ activeTab, onTabChange }: UserProfileTabsProps) {
  const { t } = useLanguage()

  const profileTabs: Array<{ key: ProfileTabKey; label: string }> = [
    { key: 'overview', label: t('overview') },
    { key: 'stats', label: t('stats') },
    { key: 'portfolio', label: t('portfolio') },
  ]

  return (
    <Box
      className="profile-tabs"
      role="tablist"
      style={{
        display: 'flex',
        gap: tokens.spacing[2],
        marginBottom: tokens.spacing[4],
        position: 'relative',
        padding: `${tokens.spacing[2]} ${tokens.spacing[6]}`,
        paddingBottom: tokens.spacing[3],
        overflowX: 'auto',
        scrollbarWidth: 'none',
        background: `linear-gradient(to bottom, ${alpha(tokens.colors.bg.secondary, 25)} 0%, transparent 100%)`,
        borderRadius: `0 0 ${tokens.radius.xl} ${tokens.radius.xl}`,
        border: `1px solid ${alpha(tokens.colors.border.primary, 31)}`,
        borderTop: 'none',
      }}
    >
      {profileTabs.map((tab) => {
        const isActive = activeTab === tab.key
        return (
          <button
            key={tab.key}
            className="profile-tab-button interactive-scale"
            onClick={() => onTabChange(tab.key)}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            style={{
              background: isActive
                ? `linear-gradient(135deg, ${alpha(tokens.colors.accent.primary, 8)}, ${alpha(tokens.colors.accent.primary, 3)})`
                : 'transparent',
              border: isActive
                ? `1px solid ${alpha(tokens.colors.accent.primary, 19)}`
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
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = `${alpha(tokens.colors.bg.tertiary, 50)}`
                e.currentTarget.style.transform = 'translateY(-2px)'
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.transform = 'translateY(0)'
              }
            }}
          >
            <Text
              size="sm"
              weight={isActive ? 'black' : 'medium'}
              style={{
                color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                transition: 'color 0.3s ease',
              }}
            >
              {tab.label}
            </Text>
          </button>
        )
      })}
    </Box>
  )
}
