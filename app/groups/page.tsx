import type { Metadata } from 'next'
'use client'

import { Suspense } from 'react'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import GroupsFeedPage from '@/app/components/groups/GroupsFeedPage'

export const metadata: Metadata = {
  title: '小组 - Arena',
  description: '浏览和加入 Arena 交易小组，与志同道合的交易者交流策略。',
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
      <GroupsFeedPage />
    </Suspense>
  )
}
