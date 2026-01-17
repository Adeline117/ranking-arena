'use client'

import { useState, lazy, Suspense } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../Base'
import TopNav from '../Layout/TopNav'
import ExchangeQuickConnect from '../ExchangeQuickConnect'
import { ErrorBoundary } from '../Utils/ErrorBoundary'
import { useToast } from '../UI/Toast'
import { useLanguage } from '../Utils/LanguageProvider'
import { JsonLd } from '../Utils/JsonLd'
import { generateWebSiteSchema, generateOrganizationSchema, combineSchemas } from '@/lib/seo'

import RankingSection from './RankingSection'
import SidebarSection from './SidebarSection'
import { useTraderData, useAuth } from './hooks'
import type { Trader } from '../Features/RankingTable'

// 懒加载对比组件
const CompareTraders = lazy(() => import('../Features/CompareTraders'))

/**
 * 首页主容器组件
 * 管理整体布局和状态协调
 */
export default function HomePage() {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { email, isLoggedIn } = useAuth()
  
  // 交易者数据管理
  const {
    traders,
    loading,
    activeTimeRange,
    changeTimeRange,
  } = useTraderData({
    onDataUpdated: () => {
      showToast(t('dataUpdated') || '数据已更新', 'success')
    },
  })

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
        className="container-padding page-enter"
        px={4}
        py={6}
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* 快速绑定交易所 */}
        <ExchangeQuickConnect />
        
        <Box
          className="main-grid stagger-children"
          style={{
            display: 'grid',
            gridTemplateColumns: '260px minmax(0, 1fr) 280px',
            gap: tokens.spacing[4],
            alignItems: 'start',
          }}
        >
          {/* 左侧：热门讨论 */}
          <SidebarSection position="left" />

          {/* 中间：排名榜 */}
          <RankingSection
            traders={traders}
            loading={loading}
            isLoggedIn={isLoggedIn}
            activeTimeRange={activeTimeRange}
            onTimeRangeChange={changeTimeRange}
          />

          {/* 右侧：市场数据 */}
          <SidebarSection position="right" />
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
    </Box>
  )
}
