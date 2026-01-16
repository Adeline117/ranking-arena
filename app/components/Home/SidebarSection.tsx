'use client'

import { lazy, Suspense } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../Base'
import Card from '../UI/Card'
import { ErrorBoundary } from '../UI/ErrorBoundary'
import { SkeletonCard } from '../UI/Skeleton'
import { useLanguage } from '../Utils/LanguageProvider'

// 懒加载组件
const PostFeed = lazy(() => import('../Features/PostFeed'))
const MarketPanel = lazy(() => import('../Features/MarketPanel'))

interface SidebarSectionProps {
  position: 'left' | 'right'
}

/**
 * 侧边栏组件
 * 左侧：热门讨论
 * 右侧：市场数据
 */
export default function SidebarSection({ position }: SidebarSectionProps) {
  const { t } = useLanguage()

  if (position === 'left') {
    return (
      <Box
        as="section"
        className="home-left-section"
        style={{
          position: 'sticky',
          top: tokens.spacing[4],
        }}
      >
        <Card title={t('hotDiscussion')}>
          <ErrorBoundary>
            <Suspense fallback={<SkeletonCard />}>
              <PostFeed />
            </Suspense>
          </ErrorBoundary>
        </Card>
        <Link
          href="/groups"
          style={{
            display: 'block',
            marginTop: tokens.spacing[3],
            textAlign: 'center',
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            background: tokens.colors.bg.secondary,
            color: tokens.colors.text.primary,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            textDecoration: 'none',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.semibold,
            transition: `all ${tokens.transition.base}`,
            boxShadow: tokens.shadow.xs,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = tokens.colors.bg.tertiary || tokens.colors.bg.hover
            e.currentTarget.style.borderColor = tokens.colors.border.secondary || tokens.colors.border.primary
            e.currentTarget.style.transform = 'translateY(-1px)'
            e.currentTarget.style.boxShadow = tokens.shadow.sm
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = tokens.colors.bg.secondary
            e.currentTarget.style.borderColor = tokens.colors.border.primary
            e.currentTarget.style.transform = 'translateY(0)'
            e.currentTarget.style.boxShadow = tokens.shadow.xs
          }}
        >
          {t('more')} →
        </Link>
      </Box>
    )
  }

  return (
    <Box
      as="section"
      className="home-right-section"
      style={{
        position: 'sticky',
        top: tokens.spacing[4],
        maxHeight: 'calc(100vh - 100px)',
        overflowY: 'auto',
      }}
    >
      <ErrorBoundary>
        <Suspense fallback={<SkeletonCard />}>
          <MarketPanel />
        </Suspense>
      </ErrorBoundary>
    </Box>
  )
}
