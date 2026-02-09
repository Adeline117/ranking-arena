'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface MarketTabsProps {
  children: (activeTab: string) => React.ReactNode
}

export default function MarketTabs({ children }: MarketTabsProps) {
  const { t } = useLanguage()
  const [active, setActive] = useState('spot')

  const tabs = [
    { key: 'spot', label: t('spot') || '现货' },
    { key: 'futures', label: t('futures') || '合约' },
    { key: 'alpha', label: t('alphaHot') || 'Alpha热门' },
  ]

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: tokens.spacing[1],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          marginBottom: tokens.spacing[4],
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActive(tab.key)}
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
              background: 'none',
              border: 'none',
              borderBottom: active === tab.key ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent',
              color: active === tab.key ? tokens.colors.text.primary : tokens.colors.text.secondary,
              fontWeight: active === tab.key ? tokens.typography.fontWeight.semibold : tokens.typography.fontWeight.normal,
              fontSize: tokens.typography.fontSize.base,
              cursor: 'pointer',
              transition: tokens.transition.fast,
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {children(active)}
    </div>
  )
}
