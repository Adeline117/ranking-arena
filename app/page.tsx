import { Suspense } from 'react'
import { HomePage } from './components/home'
import { getInitialTraders } from '@/lib/getInitialTraders'
import RankingTableSkeleton from './components/home/RankingTableSkeleton'

// ISR: Revalidate every 60 seconds — data updates via cron every 4h, 60s is plenty fresh
export const revalidate = 60
// Enable Partial Prerendering — static shell renders instantly, data streams in
export const experimental_ppr = true

/**
 * 首页入口 - Server Component with Streaming
 * 服务端预获取数据以优化 LCP
 * 使用 ISR 提供静态页面性能和动态数据更新
 *
 * Auth is handled client-side to maintain static generation
 */
export default async function Page() {
  // Fetch initial traders server-side to eliminate client waterfall
  // 首屏只加载20条，减少LCP时间；更多数据通过客户端"加载更多"按钮获取
  const { traders: initialTraders, lastUpdated } = await getInitialTraders('90D', 20)

  return (
    <Suspense fallback={<RankingTableSkeleton />}>
      <HomePage
        initialTraders={initialTraders}
        initialLastUpdated={lastUpdated}
      />
    </Suspense>
  )
}
