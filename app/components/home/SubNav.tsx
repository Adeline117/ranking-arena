'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export type SubNavTab = 'following' | 'recommended' | 'bookshelf'

interface SubNavProps {
  activeTab: SubNavTab
  onTabChange: (tab: SubNavTab) => void
}

const TABS: { key: SubNavTab; labelKey: string; icon: string; subKey?: string }[] = [
  { key: 'following', labelKey: 'subNavFollowing', icon: '' },
  { key: 'recommended', labelKey: 'subNavHot', icon: '', subKey: 'subNavHotSub' },
  { key: 'bookshelf', labelKey: 'subNavLibrary', icon: '' },
]

export default function SubNav({ activeTab, onTabChange }: SubNavProps) {
  const { t } = useLanguage()

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
