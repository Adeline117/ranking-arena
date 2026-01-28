'use client'

import { useState, lazy, Suspense, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import TopNav from '../layout/TopNav'
import MobileBottomNav from '../layout/MobileBottomNav'
// ExchangeQuickConnect 已移除 - 不在首页展示
import { ErrorBoundary } from '../Providers/ErrorBoundary'
import { useLanguage } from '../Providers/LanguageProvider'
import { JsonLd } from '../Providers/JsonLd'
import { generateWebSiteSchema, generateOrganizationSchema, combineSchemas } from '@/lib/seo'

import RankingSection from './RankingSection'
import PullToRefresh from '../ui/PullToRefresh'

// 延迟加载 StatsBar 以优化 LCP
const StatsBar = dynamic(() => import('./StatsBar'), {
  ssr: false,
  loading: () => <Box style={{ height: 48, marginBottom: 16 }} />,
})
import { useTraderData, useAuth } from './hooks'
import type { Trader } from '../ranking/RankingTable'
import type { TimeRange } from './hooks/useTraderData'
import type { InitialTrader } from '@/lib/server/getInitialTraders'

// Props interface for server-side data
interface HomePageProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
}

// 动态加载侧边栏（移动端不需要，减少首屏 JS）
// 优化：移除动画骨架以减少 LCP 阻塞
const SidebarSection = dynamic(() => import('./SidebarSection'), {
  ssr: false,
  loading: () => (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
      {[1, 2].map(i => (
        <Box key={i} style={{ height: 80, borderRadius: tokens.radius.lg, background: tokens.colors.bg.secondary }} />
      ))}
    </Box>
  ),
})

// 懒加载对比组件
const CompareTraders = lazy(() => import('../trader/CompareTraders'))

/**
 * 首页主容器组件
 * 管理整体布局和状态协调
 */
export default function HomePage({ initialTraders, initialLastUpdated }: HomePageProps) {
  const { language } = useLanguage()
  const { email, isLoggedIn } = useAuth()
  const searchParams = useSearchParams()
  const router = useRouter()

  // 交易者数据管理 - 传入服务端预获取的数据
  const {
    traders,
    loading,
    activeTimeRange,
    changeTimeRange,
    lastUpdated,
    availableSources,
    refresh,
  } = useTraderData({
    initialTraders: initialTraders as Trader[] | undefined,
    initialLastUpdated,
  })

  // Sync time range with URL on initial load
  useEffect(() => {
    const urlTimeRange = searchParams.get('range') as TimeRange | null
    if (urlTimeRange && ['90D', '30D', '7D'].includes(urlTimeRange) && urlTimeRange !== activeTimeRange) {
      changeTimeRange(urlTimeRange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run once on mount - intentionally exclude deps to prevent re-runs

  // Custom handler to update both state and URL
  const handleTimeRangeChange = (range: TimeRange) => {
    changeTimeRange(range)
    // Update URL without full navigation
    const params = new URLSearchParams(searchParams.toString())
    params.set('range', range)
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  // Pull-to-refresh handler (async for PullToRefresh component)
  const handlePullRefresh = async () => {
    if (refresh) {
      refresh()
      // Wait a bit for the refresh to process
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  // 交易者对比状态
  const [compareTraders, setCompareTraders] = useState<Trader[]>([])

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
        position: 'relative',
      }}
    >
      {/* Background mesh gradient - 优化渲染性能 */}
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: tokens.gradient.mesh,
          opacity: 0.5,
          pointerEvents: 'none',
          zIndex: 0,
          willChange: 'auto',
          contain: 'strict',
        }}
      />
      
      {/* JSON-LD 结构化数据 */}
      <JsonLd data={combineSchemas(generateWebSiteSchema(), generateOrganizationSchema())} />
      
      {/* 顶部导航 */}
      <TopNav email={email} />

      {/* 主体 - 包裹在 PullToRefresh 中实现下拉刷新 */}
      <PullToRefresh onRefresh={handlePullRefresh} disabled={loading}>
        <Box
          as="main"
          className="container-padding page-enter has-mobile-nav"
          style={{
            maxWidth: 1400,
            margin: '0 auto',
            position: 'relative',
            zIndex: 1,
            padding: '16px 16px',
          }}
        >

          {/* 数据来源滚动展示 */}
          <StatsBar />

          {/* 响应式三栏布局 */}
          <Box
            className="main-grid stagger-children"
          >
            {/* 左侧：热门讨论（仅桌面端显示，1024px+） */}
            <Box className="hide-tablet">
              <SidebarSection position="left" />
            </Box>

            {/* 中间：排名榜（始终显示） */}
            <Box style={{ minWidth: 0 }}>
              <RankingSection
                traders={traders}
                loading={loading}
                isLoggedIn={isLoggedIn}
                activeTimeRange={activeTimeRange}
                onTimeRangeChange={handleTimeRangeChange}
                lastUpdated={lastUpdated}
                onRefresh={refresh}
                availableSources={availableSources}
              />
            </Box>

            {/* 右侧：市场数据（移动端隐藏） */}
            <Box className="hide-mobile">
              <SidebarSection position="right" />
            </Box>
          </Box>
        </Box>
      </PullToRefresh>

      {/* 交易者对比面板 */}
      {compareTraders.length > 0 && (
        <ErrorBoundary>
          <Suspense fallback={
            <Box style={{
              position: 'fixed', bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))', left: '50%', transform: 'translateX(-50%)',
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`, borderRadius: tokens.radius.xl,
              background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
              boxShadow: tokens.shadow.lg, zIndex: 40,
            }}>
              <Text size="sm" color="secondary">{language === 'zh' ? '加载对比面板...' : 'Loading comparison...'}</Text>
            </Box>
          }>
            <CompareTraders
              traders={compareTraders}
              onRemove={(id) => setCompareTraders(compareTraders.filter((t) => t.id !== id))}
              onClear={() => setCompareTraders([])}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* 移动端底部导航 */}
      <MobileBottomNav />
    </Box>
  )
}
