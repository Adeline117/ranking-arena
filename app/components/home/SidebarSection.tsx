'use client'

import { lazy, Suspense } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import Card from '../ui/Card'
import { ErrorBoundary } from '../utils/ErrorBoundary'
import { SkeletonCard } from '../ui/Skeleton'
import { useLanguage } from '../Providers/LanguageProvider'
import ProFeaturesPanel from '../premium/ProFeaturesPanel'
import { useSubscription } from './hooks/useSubscription'

// 懒加载组件
const PostFeed = lazy(() => import('../post/PostFeed'))
// MarketPanel removed — replaced by WatchlistMarket on /market page

interface SidebarSectionProps {
  position: 'left' | 'right'
}

/**
 * 侧边栏组件
 * 左侧：热门讨论
 * 右侧：Pro功能 + 市场数据
 */
export default function SidebarSection({ position }: SidebarSectionProps) {
  const { t } = useLanguage()
  const { isPro } = useSubscription()

  if (position === 'left') {
    return (
      <Box
        as="section"
        className="home-left-section card-enter"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[3],
        }}
      >
        <Card title={t('hotDiscussion')} variant="glass">
          <ErrorBoundary>
            <Suspense fallback={<SkeletonCard />}>
              <PostFeed variant="compact" limit={5} />
            </Suspense>
          </ErrorBoundary>
        </Card>

        <Link
          href="/groups"
          prefetch={false}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            background: 'var(--color-sidebar-bg)',
            color: tokens.colors.text.primary,
            borderRadius: tokens.radius.lg,
            border: tokens.glass.border.light,
            textDecoration: 'none',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.bold,
            transition: tokens.transition.all,
          }}
        >
          {t('more')} →
        </Link>
      </Box>
    )
  }

  // 右侧边栏
  return (
    <Box
      as="section"
      className="home-right-section card-enter"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[3],
      }}
    >
      {/* Pro 功能面板 */}
      {!isPro && <ProFeaturesPanel compact />}

      {/* 市场数据已移至 /market 页面 */}
    </Box>
  )
}
