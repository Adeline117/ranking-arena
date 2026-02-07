'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import PostFeed from '@/app/components/post/PostFeed'

type FeedTab = 'hot' | 'latest'

export default function RecommendedFeed() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [activeTab, setActiveTab] = useState<FeedTab>('hot')

  const sortBy = activeTab === 'hot' ? 'hot_score' : 'created_at'

  return (
    <div>
      {/* Sub-tabs: hot / latest */}
      <div style={{
        display: 'flex',
        gap: 4,
        marginBottom: 16,
      }}>
        {([
          { key: 'hot' as FeedTab, label: isZh ? '热门' : 'Hot' },
          { key: 'latest' as FeedTab, label: isZh ? '最新' : 'Latest' },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '6px 16px',
              borderRadius: tokens.radius.full,
              border: 'none',
              background: activeTab === tab.key ? tokens.colors.accent.brand : 'transparent',
              color: activeTab === tab.key ? '#fff' : tokens.colors.text.secondary,
              fontWeight: activeTab === tab.key ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <PostFeed
        key={activeTab}
        sortBy={sortBy}
      />
    </div>
  )
}
