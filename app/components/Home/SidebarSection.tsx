'use client'

import { lazy, Suspense } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../Base'
import Card from '../UI/Card'
import { ErrorBoundary } from '../Utils/ErrorBoundary'
import { SkeletonCard } from '../UI/Skeleton'
import { useLanguage } from '../Utils/LanguageProvider'
import ProFeaturesPanel from '../Pro/ProFeaturesPanel'

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
        className="home-left-section card-enter"
        style={{
          position: 'sticky',
          top: 80,
          animationDelay: '0.1s',
        }}
      >
        <Card title={t('hotDiscussion')} variant="glass">
          <ErrorBoundary>
            <Suspense fallback={<SkeletonCard />}>
              <PostFeed />
            </Suspense>
          </ErrorBoundary>
        </Card>
        <Link
          href="/groups"
          className="btn-press"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: tokens.spacing[2],
            marginTop: tokens.spacing[3],
            textAlign: 'center',
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            background: tokens.glass.bg.light,
            backdropFilter: tokens.glass.blur.sm,
            WebkitBackdropFilter: tokens.glass.blur.sm,
            color: tokens.colors.text.primary,
            borderRadius: tokens.radius.lg,
            border: tokens.glass.border.light,
            textDecoration: 'none',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.bold,
            transition: tokens.transition.all,
            boxShadow: tokens.shadow.sm,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = tokens.glass.bg.medium
            e.currentTarget.style.transform = 'translateY(-2px)'
            e.currentTarget.style.boxShadow = tokens.shadow.md
            e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}40`
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = tokens.glass.bg.light
            e.currentTarget.style.transform = 'translateY(0)'
            e.currentTarget.style.boxShadow = tokens.shadow.sm
            e.currentTarget.style.borderColor = 'var(--glass-border-light)'
          }}
        >
          {t('more')} 
          <span style={{ transition: 'transform 0.2s', display: 'inline-block' }}>→</span>
        </Link>
      </Box>
    )
  }

  return (
    <Box
      as="section"
      className="home-right-section card-enter"
      style={{
        position: 'sticky',
        top: 80,
        maxHeight: 'calc(100vh - 100px)',
        animationDelay: '0.2s',
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[4],
      }}
    >
      {/* Pro 功能面板 - 固定在顶部，始终可见 */}
      <Box style={{ flexShrink: 0 }}>
        <ProFeaturesPanel compact />
      </Box>
      
      {/* 市场数据 - 可滚动区域 */}
      <Box
        style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0, // 重要：让 flex 子元素可以收缩
          paddingRight: tokens.spacing[1], // 滚动条间距
        }}
        className="scrollbar-thin"
      >
        <ErrorBoundary>
          <Suspense fallback={<SkeletonCard />}>
            <MarketPanel />
          </Suspense>
        </ErrorBoundary>
      </Box>
    </Box>
  )
}
