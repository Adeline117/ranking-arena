'use client'

import { useEffect, useState, Suspense } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import ThreeColumnLayout from '@/app/components/layout/ThreeColumnLayout'
import PopularTradersWidget from '@/app/components/sidebar/PopularTraders'
import RecommendedGroupsWidget from '@/app/components/sidebar/RecommendedGroups'
import MyGroupsWidget from '@/app/components/sidebar/MyGroups'
import NewsFlashWidget from '@/app/components/sidebar/NewsFlash'
import { Box } from '@/app/components/base'
import CreatePostFAB from '@/app/components/ui/CreatePostFAB'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import HomePageWithSubNav from '@/app/components/home/HomePageWithSubNav'
import PostFeed from '@/app/components/post/PostFeed'

function GroupsContent() {
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null))
  }, [])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1400, margin: '0 auto' }}>
        <ThreeColumnLayout
          leftSidebar={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: 'calc(100vh - 72px)' }}>
              <div style={{ flexShrink: 0, maxHeight: '35%', overflow: 'auto' }}>
                <PopularTradersWidget />
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <RecommendedGroupsWidget />
              </div>
            </div>
          }
          rightSidebar={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: 'calc(100vh - 72px)' }}>
              <div style={{ flexShrink: 0, maxHeight: '35%', overflow: 'auto' }}>
                <MyGroupsWidget />
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <NewsFlashWidget />
              </div>
            </div>
          }
        >
          <HomePageWithSubNav
            recommendedContent={
              <Suspense fallback={<RankingSkeleton />}>
                <PostFeed sortBy="hot_score" layout="masonry" />
              </Suspense>
            }
          />
        </ThreeColumnLayout>
      </Box>
      <CreatePostFAB />
    </Box>
  )
}

export default function GroupsPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <GroupsContent />
    </Suspense>
  )
}
