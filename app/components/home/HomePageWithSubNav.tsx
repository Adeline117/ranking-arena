'use client'

import { useState, Suspense, lazy, type ReactNode } from 'react'
import SubNav, { type SubNavTab } from './SubNav'
import { tokens } from '@/lib/design-tokens'

const FollowingFeed = lazy(() => import('./FollowingFeed'))
const BookshelfTab = lazy(() => import('./BookshelfTab'))

interface Props {
  /** The existing recommended content (ranking table etc) */
  recommendedContent: ReactNode
}

export default function HomePageWithSubNav({ recommendedContent }: Props) {
  const [activeTab, setActiveTab] = useState<SubNavTab>('recommended')

  return (
    <>
      <SubNav activeTab={activeTab} onTabChange={setActiveTab} />
      {activeTab === 'recommended' && recommendedContent}
      {activeTab === 'following' && (
        <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: tokens.radius.lg }} />}>
          <FollowingFeed />
        </Suspense>
      )}
      {activeTab === 'bookshelf' && (
        <Suspense fallback={<div className="skeleton" style={{ height: 300, borderRadius: tokens.radius.lg }} />}>
          <BookshelfTab />
        </Suspense>
      )}
    </>
  )
}
