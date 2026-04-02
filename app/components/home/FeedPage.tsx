'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh'
import { supabase } from '@/lib/supabase/client'
import PostFeed from '@/app/components/post/PostFeed'
import TopNav from '@/app/components/layout/TopNav'
import DesktopSidebar from '@/app/components/layout/DesktopSidebar'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
// MobileBottomNav is rendered by root layout — do not duplicate here
import FollowingFeed from '@/app/components/home/FollowingFeed'
import { Box } from '@/app/components/base'

type FeedTab = 'hot' | 'latest' | 'following'

export default function FeedPage() {
  const { t, language: _language } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<FeedTab>('hot')

  useEffect(() => {
    // Use getSession() — reads from local storage, no network request
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null)
    }).catch(() => { /* Intentionally swallowed: session check non-critical for feed page */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [])

  const sortBy = activeTab === 'following' ? 'created_at' : (activeTab === 'hot' ? 'hot_score' : 'created_at')

  const [refreshKey, setRefreshKey] = useState(0)
  const handleRefresh = useCallback(async () => {
    setRefreshKey(k => k + 1)
  }, [])
  const { containerRef: ptrRef, indicatorRef: ptrIndicatorRef } = usePullToRefresh({
    onRefresh: handleRefresh,
  })

  return (
    <Box ref={ptrRef} className="pull-to-refresh-wrapper" style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <div ref={ptrIndicatorRef} className="pull-to-refresh-indicator" />
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
            { key: 'hot' as FeedTab, label: t('feedRecommendedTab') },
            { key: 'latest' as FeedTab, label: t('feedLatestTab') },
            { key: 'following' as FeedTab, label: t('feedFollowingTab') },
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
                color: activeTab === tab.key ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                fontWeight: activeTab === tab.key ? 800 : 600,
                fontSize: tokens.typography.fontSize.base,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
              }}
              className={activeTab !== tab.key ? 'hover-bg-secondary' : ''}
            >
              {tab.label}
            </button>
          ))}
        </Box>

        {/* Post feed */}
        {activeTab === 'following' ? (
          <FollowingFeed key={`following-${refreshKey}`} />
        ) : (
          <PostFeed
            key={`${activeTab}-${refreshKey}`}
            layout="masonry"
            sortBy={sortBy}
          />
        )}
      </Box>

      <FloatingActionButton />
    </Box>
  )
}
