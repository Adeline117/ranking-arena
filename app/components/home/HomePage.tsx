import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import TopNav from '../layout/TopNav'
import MobileBottomNav from '../layout/MobileBottomNav'
import { JsonLd } from '../Providers/JsonLd'
import { generateWebSiteSchema, generateOrganizationSchema, combineSchemas } from '@/lib/seo'
import StatsBar from './StatsBar'
import HomePageClient from './HomePageClient'
import type { InitialTrader } from '@/lib/getInitialTraders'

// Props interface for server-side data
interface HomePageProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
}

// 懒加载侧边栏组件（非关键路径）
// 使用 next/dynamic 替代 React.lazy — 提供 ssr:false 跳过服务端渲染，加速 TTFB
const SidebarSection = dynamic(() => import('./SidebarSection'), { ssr: false })

/**
 * 首页主容器组件 - Server Component
 * 服务端渲染，客户端交互由 HomePageClient 处理
 *
 * 性能优化：
 * - 服务器组件减少客户端 JS
 * - Suspense streaming 实现渐进式加载
 * - 侧边栏延迟加载不阻塞主内容
 */
export default function HomePage({
  initialTraders,
  initialLastUpdated,
}: HomePageProps) {
  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
        position: 'relative',
      }}
    >
      {/* Background mesh gradient - GPU 加速 */}
      <Box
        className="mesh-gradient-bg"
        style={{
          position: 'fixed',
          inset: 0,
          background: tokens.gradient.mesh,
          opacity: 0.5,
          pointerEvents: 'none',
          zIndex: 0,
          transform: 'translateZ(0)',
          backfaceVisibility: 'hidden',
          contain: 'strict layout paint',
        }}
      />

      {/* JSON-LD 结构化数据 */}
      <JsonLd data={combineSchemas(generateWebSiteSchema(), generateOrganizationSchema())} />

      {/* 顶部导航 - Auth handled client-side */}
      <TopNav email={null} />

      {/* 主体容器 */}
      <Box
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
        <Suspense fallback={<div style={{ height: 40 }} />}>
          <StatsBar />
        </Suspense>

        {/* 响应式三栏布局 */}
        <Box className="main-grid">
          {/* 左侧：热门讨论（仅桌面端显示，1024px+） */}
          <Box className="hide-tablet">
            <Suspense fallback={
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {[1, 2].map(i => (
                  <Box key={i} className="skeleton" style={{ height: 200, borderRadius: 12 }} />
                ))}
              </Box>
            }>
              <SidebarSection position="left" />
            </Suspense>
          </Box>

          {/* 中间：排名榜（始终显示） - 优先渲染 */}
          <Box style={{ minWidth: 0 }}>
            <Suspense fallback={
              <Box style={{ minHeight: '60vh' }}>
                <div className="skeleton" style={{ height: 400, borderRadius: 12 }} />
              </Box>
            }>
              <HomePageClient
                initialTraders={initialTraders}
                initialLastUpdated={initialLastUpdated}
              />
            </Suspense>
          </Box>

          {/* 右侧：市场数据（移动端隐藏） */}
          <Box className="hide-mobile">
            <Suspense fallback={
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {[1, 2].map(i => (
                  <Box key={i} className="skeleton" style={{ height: 200, borderRadius: 12 }} />
                ))}
              </Box>
            }>
              <SidebarSection position="right" />
            </Suspense>
          </Box>
        </Box>
      </Box>

      {/* 移动端底部导航 */}
      <MobileBottomNav />
    </Box>
  )
}
