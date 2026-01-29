import { Suspense } from 'react'
import { HomePage } from './components/home'
import { getInitialTraders } from '@/lib/server/getInitialTraders'

// ISR: Revalidate every 60 seconds for fresh data with static benefits
export const revalidate = 60

/**
 * 首页入口 - Server Component
 * 服务端预获取数据以优化 LCP
 * 使用 ISR 提供静态页面性能和动态数据更新
 */
export default async function Page() {
  // Fetch initial traders server-side to eliminate client waterfall
  // Increased from 50 to 200 for better LCP (covers most user views without client fetch)
  const { traders: initialTraders, lastUpdated } = await getInitialTraders('90D', 200)

  return (
    <Suspense>
      <HomePage
        initialTraders={initialTraders}
        initialLastUpdated={lastUpdated}
      />
    </Suspense>
  )
}
