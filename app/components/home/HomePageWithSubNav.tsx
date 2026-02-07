'use client'

import { useState, Suspense, lazy, type ReactNode } from 'react'
import SubNav, { type SubNavTab } from './SubNav'

const FollowingFeed = lazy(() => import('./FollowingFeed'))
const RecommendedFeed = lazy(() => import('./RecommendedFeed'))
const BookshelfTab = lazy(() => import('./BookshelfTab'))

interface Props {
  /** The existing ranking content (ranking table + sidebars) */
  rankingContent: ReactNode
}

export default function HomePageWithSubNav({ rankingContent }: Props) {
  const [activeTab, setActiveTab] = useState<SubNavTab>('recommended')

  return (
    <>
      <SubNav activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === 'recommended' && (
        <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: 12 }} />}>
          <RecommendedFeed />
        </Suspense>
      )}

      {activeTab === 'following' && (
        <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: 12 }} />}>
          <FollowingFeed />
        </Suspense>
      )}

      {activeTab === 'bookshelf' && (
        <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: 12 }} />}>
          <BookshelfTab />
        </Suspense>
      )}

      {/* Rankings always visible below the feed */}
      {rankingContent}
    </>
  )
}
