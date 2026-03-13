'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { features } from '@/lib/features'

export type SubNavTab = 'following' | 'recommended' | 'bookshelf'

interface SubNavProps {
  activeTab: SubNavTab
  onTabChange: (tab: SubNavTab) => void
}

const ALL_TABS: { key: SubNavTab; labelKey: string; icon: string; subKey?: string; social?: boolean }[] = [
  { key: 'following', labelKey: 'subNavFollowing', icon: '', social: true },
  { key: 'recommended', labelKey: 'subNavHot', icon: '', subKey: 'subNavHotSub', social: true },
  { key: 'bookshelf', labelKey: 'subNavLibrary', icon: '' },
]

const TABS = ALL_TABS.filter(tab => {
  if (tab.social) return features.social
  return true
})

/** Default tab when social is disabled (only non-social tabs remain) */
export const DEFAULT_TAB: SubNavTab = TABS.length > 0 ? TABS[0].key : 'bookshelf'

export default function SubNav({ activeTab, onTabChange }: SubNavProps) {
  const { t } = useLanguage()

  // Don't render a tab bar when there's only one tab
  if (TABS.length <= 1) return null

  return (
    <div
      role="tablist"
      aria-label={t('subNavContentCategories')}
      style={{
      display: 'flex',
      gap: 4,
      marginBottom: 16,
      borderBottom: `1px solid ${tokens.colors.border.primary}`,
      paddingBottom: 0,
    }}>
      {TABS.map(tab => {
        const isActive = activeTab === tab.key
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onTabChange(tab.key)}
            className="btn-press"
            style={{
              padding: '8px 16px',
              fontSize: 14,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? tokens.colors.accent.brand : tokens.colors.text.secondary,
              background: 'transparent',
              border: 'none',
              borderBottom: isActive ? `2px solid ${tokens.colors.accent.brand}` : '2px solid transparent',
              cursor: 'pointer',
              transition: `all ${tokens.transition.base}`,
              marginBottom: -1,
              borderRadius: `${tokens.radius.md} ${tokens.radius.md} 0 0`,
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = tokens.colors.text.primary
                e.currentTarget.style.backgroundColor = 'var(--color-bg-hover)'
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = tokens.colors.text.secondary
                e.currentTarget.style.backgroundColor = 'transparent'
              }
            }}
          >
            {tab.icon} {t(tab.labelKey)}
            {tab.subKey && (
              <span style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 400,
                color: isActive ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
                marginTop: 1,
                opacity: 0.8,
              }}>
                {t(tab.subKey!)}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
