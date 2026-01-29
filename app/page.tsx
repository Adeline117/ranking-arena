import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/db'
import { HomePage } from './components/home'
import { getInitialTraders } from '@/lib/getInitialTraders'
import RankingTableSkeleton from './components/home/RankingTableSkeleton'

// ISR: Revalidate every 30 seconds for fresh data with static benefits
// Reduced from 60s to 30s for better data freshness while maintaining cache benefits
export const revalidate = 30

/**
 * 首页入口 - Server Component with Streaming
 * 服务端预获取数据以优化 LCP
 * 使用 ISR 提供静态页面性能和动态数据更新
 */
export default async function Page() {
  // Fetch initial traders server-side to eliminate client waterfall
  const { traders: initialTraders, lastUpdated } = await getInitialTraders('90D', 50)

  // Get auth session server-side (non-blocking)
  let email: string | null = null
  let isLoggedIn = false

  try {
    const cookieStore = await cookies()
    const supabase = createClient(cookieStore)
    const { data: { session } } = await supabase.auth.getSession()
    email = session?.user?.email ?? null
    isLoggedIn = !!session
  } catch (error) {
    // Silent fail - auth is not critical for page render
    console.error('[Page] Auth check failed:', error)
  }

  return (
    <Suspense fallback={<RankingTableSkeleton />}>
      <HomePage
        initialTraders={initialTraders}
        initialLastUpdated={lastUpdated}
        email={email}
        isLoggedIn={isLoggedIn}
      />
    </Suspense>
  )
}
