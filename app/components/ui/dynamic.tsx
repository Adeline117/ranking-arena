'use client'

/**
 * Dynamic UI Components
 *
 * Lazy loads heavy modal and dialog components
 * to reduce initial bundle size.
 *
 * Usage:
 *   import { DynamicCommentsModal, DynamicPostDetailModal } from '@/app/components/ui/dynamic'
 */

import dynamic from 'next/dynamic'

// Score Rules Modal - Not frequently used
export const DynamicScoreRulesModal = dynamic(
  () => import('./ScoreRulesModal'),
  { ssr: false }
)

// Follow List Modal - Only shown when clicking followers/following
export const DynamicFollowListModal = dynamic(
  () => import('./FollowListModal'),
  { ssr: false }
)

// Bookmark Modal - Only shown when bookmarking
export const DynamicBookmarkModal = dynamic(
  () => import('./BookmarkModal'),
  { ssr: false }
)

// Comments Modal from post components
export const DynamicCommentsModal = dynamic(
  () => import('../post/CommentsModal'),
  { ssr: false }
)

// Post Detail Modal
export const DynamicPostDetailModal = dynamic(
  () => import('../post/PostDetailModal'),
  { ssr: false }
)

// Post Create/Edit Modal (named export)
export const DynamicPostModal = dynamic(
  () => import('../post/components/PostModal').then(mod => ({ default: mod.Modal })),
  { ssr: false }
)
