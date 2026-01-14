'use client'

import { useEffect, useState, lazy, Suspense, useCallback, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { logError } from '@/lib/utils/error-handler'

import TopNav from './components/Layout/TopNav'
import RankingTable, { type Trader } from './components/Features/RankingTable'
import Card from './components/UI/Card'
import ExchangeQuickConnect from './components/ExchangeQuickConnect'
import { Box } from './components/Base'
import { useLanguage } from './components/Utils/LanguageProvider'
import { ErrorBoundary } from './components/UI/ErrorBoundary'
import { SkeletonCard } from './components/UI/Skeleton'
import { useToast } from './components/UI/Toast'

// 懒加载非关键组件
const PostFeed = lazy(() => import('./components/Features/PostFeed'))
const MarketPanel = lazy(() => import('./components/Features/MarketPanel'))
const CompareTraders = lazy(() => import('./components/Features/CompareTraders'))

// 本地存储 key
const TIME_RANGE_STORAGE_KEY = 'ranking_time_range'

/* =====================
   Page
===================== */

export default function HomePage() {
  const { t } = useLanguage()
  const { showToast } = useToast()
  
  /* ---------- auth ---------- */
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  /* ---------- ranking flow (懒加载：只加载当前选中的时间段) ---------- */
  // 使用 Map 缓存已加载的数据
  const tradersCache = useRef<Map<string, Trader[]>>(new Map())
  const [currentTraders, setCurrentTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)
  
  // 从 localStorage 读取用户偏好的时间段
  const [activeTimeRange, setActiveTimeRange] = useState<'90D' | '30D' | '7D'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(TIME_RANGE_STORAGE_KEY)
      if (saved === '90D' || saved === '30D' || saved === '7D') {
        return saved
      }
    }
    return '90D'
  })

  // 加载单个时间段数据
  const loadTimeRange = useCallback(async (timeRange: '7D' | '30D' | '90D', forceRefresh = false): Promise<Trader[]> => {
    // 检查缓存（非强制刷新时）
    if (!forceRefresh && tradersCache.current.has(timeRange)) {
      return tradersCache.current.get(timeRange) || []
    }
    
    try {
      const response = await fetch(`/api/traders?timeRange=${timeRange}`)
      if (!response.ok) {
        console.error(`[HomePage] ${timeRange} API 错误`)
        return tradersCache.current.get(timeRange) || []
      }
      const data = await response.json()
      const traders = data.traders || []
      
      // 更新缓存
      tradersCache.current.set(timeRange, traders)
      
      return traders
    } catch (error) {
      console.error(`[HomePage] 加载 ${timeRange} 数据失败:`, error)
      return tradersCache.current.get(timeRange) || []
    }
  }, [])

  // 加载当前选中时间段的数据
  const loadCurrentData = useCallback(async (forceRefresh = false) => {
    setLoadingTraders(true)
    try {
      const traders = await loadTimeRange(activeTimeRange, forceRefresh)
      setCurrentTraders(traders)
      
      if (forceRefresh) {
        showToast(t('dataUpdated') || '数据已更新', 'success')
      }
    } catch (error) {
      console.error('[HomePage] 加载交易者数据失败:', error)
      logError(error, 'HomePage')
      setCurrentTraders([])
    } finally {
      setLoadingTraders(false)
    }
  }, [activeTimeRange, loadTimeRange, showToast, t])

  // 初次加载和时间段切换时加载数据
  useEffect(() => {
    loadCurrentData()
  }, [loadCurrentData])

  // 保存时间段偏好到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, activeTimeRange)
    }
  }, [activeTimeRange])
  
  // 每5分钟自动刷新当前时间段数据
  useEffect(() => {
    const interval = setInterval(() => {
      loadCurrentData(true)
    }, 5 * 60 * 1000)
    
    return () => clearInterval(interval)
  }, [loadCurrentData])

  // 切换时间段的处理函数
  const handleTimeRangeChange = useCallback((range: '90D' | '30D' | '7D') => {
    setActiveTimeRange(range)
  }, [])

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
                  onClick={() => handleTimeRangeChange(range)}
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
              source={currentTraders.length > 0 ? currentTraders[0].source : 'all'}
              timeRange={activeTimeRange}
            />
          </Box>

          {/* 右：市场 */}
          <Box 
            as="section" 
            className="home-right-section"
            style={{
              position: 'sticky',
              top: tokens.spacing[4],
              alignSelf: 'start',
            }}
          >
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
