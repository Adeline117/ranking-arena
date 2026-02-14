'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export type SubNavTab = 'following' | 'recommended' | 'bookshelf'

interface SubNavProps {
  activeTab: SubNavTab
  onTabChange: (tab: SubNavTab) => void
}

const TABS: { key: SubNavTab; zhLabel: string; enLabel: string; icon: string; zhSub?: string; enSub?: string }[] = [
  { key: 'following', zhLabel: '关注', enLabel: 'Following', icon: '' },
  { key: 'recommended', zhLabel: '热榜', enLabel: 'Hot', icon: '', zhSub: '全站热门帖子', enSub: 'Trending posts' },
  { key: 'bookshelf', zhLabel: '书架', enLabel: 'Library', icon: '' },
]

export default function SubNav({ activeTab, onTabChange }: SubNavProps) {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  return (
    <div style={{
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
            {tab.icon} {isZh ? tab.zhLabel : tab.enLabel}
            {tab.zhSub && (
              <span style={{
                display: 'block',
                fontSize: 10,
                fontWeight: 400,
                color: isActive ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
                marginTop: 1,
                opacity: 0.8,
              }}>
                {isZh ? tab.zhSub : tab.enSub}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
