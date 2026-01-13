'use client'

import { useEffect, useState, lazy, Suspense } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import {
  getAllLatestTimestamps,
  getAllLatestSnapshots,
  getAllTraderHandles,
  type TraderSource,
} from '@/lib/data/trader-snapshots'
import { logError } from '@/lib/utils/error-handler'

import TopNav from './components/Layout/TopNav'
import RankingTable, { type Trader } from './components/Features/RankingTable'
import Card from './components/UI/Card'
import ExchangeQuickConnect from './components/ExchangeQuickConnect'
import { Box } from './components/Base'
import { useLanguage } from './components/Utils/LanguageProvider'
import { ErrorBoundary } from './components/UI/ErrorBoundary'
import { SkeletonCard } from './components/UI/Skeleton'

// 懒加载非关键组件
const PostFeed = lazy(() => import('./components/Features/PostFeed'))
const MarketPanel = lazy(() => import('./components/Features/MarketPanel'))
const CompareTraders = lazy(() => import('./components/Features/CompareTraders'))

/* =====================
   Page
===================== */

export default function HomePage() {
  const { t } = useLanguage()
  
  /* ---------- auth ---------- */
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  /* ---------- ranking flow (多时间段) ---------- */
  const [traders90D, setTraders90D] = useState<Trader[]>([])
  const [traders30D, setTraders30D] = useState<Trader[]>([])
  const [traders7D, setTraders7D] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)
  const [activeTimeRange, setActiveTimeRange] = useState<'90D' | '30D' | '7D'>('90D')

  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      try {
        const { loadAllTraders } = await import('@/lib/data/trader-loader')
        
        // 并行加载三个时间段的数据
        const [data90D, data30D, data7D] = await Promise.all([
          loadAllTraders(supabase, '90D'),
          loadAllTraders(supabase, '30D'),
          loadAllTraders(supabase, '7D'),
        ])
        
        console.log('[HomePage] 加载到的交易者数据:', {
          '90D': data90D.length,
          '30D': data30D.length,
          '7D': data7D.length,
        })
        
        setTraders90D(data90D)
        setTraders30D(data30D)
        setTraders7D(data7D)
      } catch (error) {
        console.error('[HomePage] 加载交易者数据失败:', error)
        logError(error, 'HomePage')
        setTraders90D([])
        setTraders30D([])
        setTraders7D([])
      } finally {
        setLoadingTraders(false)
      }
    }

    load()
    
    // 每5分钟自动刷新一次数据
    const interval = setInterval(() => {
      load()
    }, 5 * 60 * 1000)
    
    return () => clearInterval(interval)
  }, [email])
  
  // 根据当前选择的时间段返回对应的数据
  const currentTraders = activeTimeRange === '90D' ? traders90D : activeTimeRange === '30D' ? traders30D : traders7D

  /* ---------- trader compare ---------- */
  const [compareTraders, setCompareTraders] = useState<Trader[]>([])

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      {/* 顶部导航 */}
      <TopNav email={email} />

      {/* 主体 */}
      <Box
        as="main"
        className="container-padding"
        px={4}
        py={6}
        style={{
          maxWidth: 1200,
          margin: '0 auto',
        }}
      >
        {/* 快速绑定交易所 */}
        <ExchangeQuickConnect />
        <Box
          className="main-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: '320px 1fr 280px',
            gap: tokens.spacing[4],
          }}
        >
          {/* 左：热门讨论 */}
          <Box as="section" className="home-left-section">
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

          {/* 中：排名流（产品核心） */}
          <Box as="section" className="home-ranking-section">
            {/* 时间段切换按钮 */}
            <Box
              style={{
                display: 'flex',
                gap: tokens.spacing[2],
                marginBottom: tokens.spacing[3],
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              {(['90D', '30D', '7D'] as const).map((range) => (
                <button
                  key={range}
                  onClick={() => setActiveTimeRange(range)}
                  style={{
                    flex: 1,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                    background: activeTimeRange === range ? tokens.colors.bg.primary : 'transparent',
                    color: activeTimeRange === range ? tokens.colors.text.primary : tokens.colors.text.tertiary,
                    border: activeTimeRange === range ? `1px solid ${tokens.colors.border.primary}` : '1px solid transparent',
                    borderRadius: tokens.radius.md,
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: activeTimeRange === range ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                    cursor: 'pointer',
                    transition: `all ${tokens.transition.base}`,
                  }}
                >
                  {range === '90D' ? t('days90') : range === '30D' ? t('days30') : t('days7')}
                </button>
              ))}
            </Box>
            
            <RankingTable
              traders={currentTraders}
              loading={loadingTraders}
              loggedIn={!!email}
              source={currentTraders.length > 0 ? currentTraders[0].source : 'binance'}
              timeRange={activeTimeRange}
            />
          </Box>

          {/* 右：市场 */}
          <Box as="section" className="home-right-section">
            <ErrorBoundary>
              <Suspense fallback={<SkeletonCard />}>
                <MarketPanel />
              </Suspense>
            </ErrorBoundary>
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
    </Box>
  )
}
