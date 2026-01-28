import { Suspense } from 'react'
import { HomePage } from './components/home'
import { getInitialTraders } from '@/lib/server/getInitialTraders'

/**
 * 首页入口 - Server Component
 * 服务端预获取数据以优化 LCP
 */
export default async function Page() {
  // Fetch initial traders server-side to eliminate client waterfall
  const { traders: initialTraders, lastUpdated } = await getInitialTraders('90D', 50)

  return (
    <Suspense>
      <HomePage
        initialTraders={initialTraders}
        initialLastUpdated={lastUpdated}
      />
    </Suspense>
  )
}
