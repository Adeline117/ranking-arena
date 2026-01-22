'use client'

import { useState, lazy, Suspense, useMemo } from 'react'
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

// 懒加载对比组件
const CompareTraders = lazy(() => import('../trader/CompareTraders'))

/**
 * 首页主容器组件
 * 管理整体布局和状态协调
 */
export default function HomePage() {
  const { t } = useLanguage()
  const { email, isLoggedIn } = useAuth()
  
  // 交易者数据管理
  const {
    traders,
    loading,
    error,
    activeTimeRange,
    changeTimeRange,
    refresh,
  } = useTraderData()

  // 交易者对比状态
  const [compareTraders, setCompareTraders] = useState<Trader[]>([])

  // 计算统计数据
  const statsData = useMemo(() => {
    if (!traders || traders.length === 0) {
      return {
        totalTraders: 0,
        averageRoi: 0,
        topPerformer: undefined,
        activeExchanges: 5,
      }
    }

    const totalTraders = traders.length
    const averageRoi = traders.reduce((sum, t) => sum + (t.roi || 0), 0) / totalTraders

    const topTrader = traders.reduce((best, current) =>
      (current.roi || 0) > (best?.roi || 0) ? current : best
    , traders[0])

    const uniqueExchanges = new Set(traders.map(t => t.source).filter(Boolean))

    return {
      totalTraders,
      averageRoi,
      topPerformer: topTrader?.handle ? { handle: topTrader.handle, roi: topTrader.roi || 0 } : undefined,
      activeExchanges: uniqueExchanges.size || 5,
    }
  }, [traders])

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

        {/* 市场概览统计 */}
        <StatsBar
          totalTraders={statsData.totalTraders}
          averageRoi={statsData.averageRoi}
          topPerformer={statsData.topPerformer}
          activeExchanges={statsData.activeExchanges}
          loading={loading}
        />

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
            onTimeRangeChange={changeTimeRange}
            error={error}
            onRetry={refresh}
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
