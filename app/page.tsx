import { Suspense } from 'react'
import { HomePage } from './components/home'
import { getInitialTraders } from '@/lib/server/getInitialTraders'
import HomePageShell from './components/home/HomePageShell'
import RankingTableSkeleton from './components/home/RankingTableSkeleton'
import TopNav from './components/layout/TopNav'
import MobileBottomNav from './components/layout/MobileBottomNav'
import StatsBar from './components/home/StatsBar'
import { Box } from './components/base'

// ISR: Revalidate every 60 seconds for fresh data with static benefits
export const revalidate = 60

/**
 * 首页入口 - Server Component with Streaming
 *
 * Architecture:
 * 1. HomePageShell renders immediately (static layout)
 * 2. StatsBar renders with skeleton (simple component)
 * 3. RankingTable streams in with data (suspense boundary)
 * 4. Sidebars load client-side (non-critical)
 */
export default async function Page() {
  // Fetch initial traders server-side to eliminate client waterfall
  // Increased from 50 to 200 for better LCP (covers most user views without client fetch)
  const { traders: initialTraders, lastUpdated } = await getInitialTraders('90D', 200)

  return (
    <HomePageShell
      topNav={<TopNav email={null} />}
      bottomNav={<MobileBottomNav />}
    >
      {/* 数据来源滚动展示 */}
      <Suspense fallback={<div style={{ height: 30, marginBottom: 16 }} />}>
        <StatsBar />
      </Suspense>

      {/* 响应式三栏布局 */}
      <Box className="main-grid stagger-children">
        {/* 左侧：热门讨论（仅桌面端显示，1024px+） */}
        <Box className="hide-tablet">
          {/* SidebarSection loads client-side */}
        </Box>

        {/* 中间：排名榜（始终显示） - streaming with Suspense */}
        <Box style={{ minWidth: 0 }}>
          <Suspense fallback={<RankingTableSkeleton />}>
            <HomePage
              initialTraders={initialTraders}
              initialLastUpdated={lastUpdated}
            />
          </Suspense>
        </Box>

        {/* 右侧：市场数据（移动端隐藏） */}
        <Box className="hide-mobile">
          {/* SidebarSection loads client-side */}
        </Box>
      </Box>
    </HomePageShell>
  )
}
