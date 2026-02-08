'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import PostFeed from '@/app/components/post/PostFeed'
import TopNav from '@/app/components/layout/TopNav'
import DesktopSidebar from '@/app/components/layout/DesktopSidebar'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import dynamic from 'next/dynamic'
const MobileBottomNav = dynamic(() => import('@/app/components/layout/MobileBottomNav'), { ssr: false })
import { Box } from '@/app/components/base'

type FeedTab = 'hot' | 'latest'

export default function FeedPage() {
  const { language } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<FeedTab>('hot')

  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  const sortBy = activeTab === 'hot' ? 'hot_score' : 'created_at'

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      {/* Desktop sidebar - hidden on mobile */}
      <div className="hide-mobile hide-tablet">
        <DesktopSidebar />
      </div>

      {/* Main content area */}
      <Box
        as="main"
        className="feed-main-content"
        style={{
          maxWidth: 960,
          margin: '0 auto',
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          paddingBottom: 100,
        }}
      >
        {/* Feed tabs */}
        <Box
          style={{
            display: 'flex',
            gap: tokens.spacing[1],
            marginBottom: tokens.spacing[3],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            paddingBottom: tokens.spacing[2],
          }}
        >
          {([
            { key: 'hot' as FeedTab, label: language === 'zh' ? '推荐' : 'Recommended' },
            { key: 'latest' as FeedTab, label: language === 'zh' ? '最新' : 'Latest' },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                minHeight: 44,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: activeTab === tab.key ? tokens.gradient.primary : 'transparent',
                color: activeTab === tab.key ? '#fff' : tokens.colors.text.secondary,
                fontWeight: activeTab === tab.key ? 800 : 600,
                fontSize: tokens.typography.fontSize.base,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                if (activeTab !== tab.key) {
                  e.currentTarget.style.background = tokens.colors.bg.secondary
                  e.currentTarget.style.color = tokens.colors.text.primary
                }
              }}
              onMouseLeave={(e) => {
                if (activeTab !== tab.key) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = tokens.colors.text.secondary
                }
              }}
            >
              {tab.label}
            </button>
          ))}
        </Box>

        {/* Post feed - no groupId filter shows all posts */}
        <PostFeed
          key={activeTab}
          layout="masonry"
          sortBy={sortBy}
        />
      </Box>

      <FloatingActionButton />
      <MobileBottomNav />
    </Box>
  )
}
