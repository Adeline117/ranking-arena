'use client'

import { useState, lazy, Suspense, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import TopNav from '../layout/TopNav'
import MobileBottomNav from '../layout/MobileBottomNav'
import ExchangeQuickConnect from '../exchange/ExchangeQuickConnect'
import { ErrorBoundary } from '../Providers/ErrorBoundary'
import { useLanguage } from '../Providers/LanguageProvider'
import { JsonLd } from '../Providers/JsonLd'
import { generateWebSiteSchema, generateOrganizationSchema, combineSchemas } from '@/lib/seo'

import RankingSection from './RankingSection'
import SidebarSection from './SidebarSection'
import StatsBar from './StatsBar'
import { useTraderData, useAuth } from './hooks'
import type { Trader } from '../ranking/RankingTable'
import type { TimeRange } from './hooks/useTraderData'

// 懒加载对比组件
const CompareTraders = lazy(() => import('../trader/CompareTraders'))

/**
 * 首页主容器组件
 * 管理整体布局和状态协调
 */
export default function HomePage() {
  useLanguage() // Initialize language context
  const { email, isLoggedIn } = useAuth()
  const searchParams = useSearchParams()
  const router = useRouter()

  // 交易者数据管理
  const {
    traders,
    loading,
    error,
    activeTimeRange,
    changeTimeRange,
    lastUpdated,
  } = useTraderData()

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
      {/* Background mesh gradient */}
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: tokens.gradient.mesh,
          opacity: 0.5,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      
      {/* JSON-LD 结构化数据 */}
      <JsonLd data={combineSchemas(generateWebSiteSchema(), generateOrganizationSchema())} />
      
      {/* 顶部导航 */}
      <TopNav email={email} />

      {/* 主体 */}
      <Box
        as="main"
        className="container-padding page-enter has-mobile-nav"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          position: 'relative',
          zIndex: 1,
          padding: '16px 12px',
        }}
      >
        {/* 快速绑定交易所 */}
        <ExchangeQuickConnect />

        {/* 数据来源滚动展示 */}
        <StatsBar />

        {/* 响应式三栏布局 */}
        <Box
          className="main-grid stagger-children"
        >
          {/* 左侧：热门讨论（移动端隐藏） */}
          <Box className="hide-mobile">
            <SidebarSection position="left" />
          </Box>

          {/* 中间：排名榜（始终显示） */}
          <RankingSection
            traders={traders}
            loading={loading}
            isLoggedIn={isLoggedIn}
            activeTimeRange={activeTimeRange}
            onTimeRangeChange={handleTimeRangeChange}
            lastUpdated={lastUpdated}
          />

          {/* 右侧：市场数据（移动端隐藏） */}
          <Box className="hide-mobile">
            <SidebarSection position="right" />
          </Box>
        </Box>
      </Box>

      {/* 交易者对比面板 */}
      {compareTraders.length > 0 && (
        <ErrorBoundary>
          <Suspense fallback={null}>
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
