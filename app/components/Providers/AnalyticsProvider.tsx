'use client'

import { useEffect, ReactNode, Suspense } from 'react'
import { usePageTracking, useUserTracking, getTracker } from '@/lib/analytics'

interface AnalyticsProviderProps {
  children: ReactNode
  userId?: string
  enabled?: boolean
  debug?: boolean
  endpoint?: string
}

/**
 * 内部组件：处理路由追踪
 * 需要在 Suspense 边界内使用，因为 useSearchParams 需要
 */
function AnalyticsTracker({ userId }: { userId?: string }) {
  // 自动追踪页面浏览
  usePageTracking()
  
  // 追踪用户身份
  useUserTracking(userId)
  
  return null
}

/**
 * Analytics Provider 组件
 * 在应用根部使用，启用全局埋点追踪
 * 
 * @example
 * ```tsx
 * <AnalyticsProvider userId={user?.id} enabled={true}>
 *   <App />
 * </AnalyticsProvider>
 * ```
 */
export default function AnalyticsProvider({
  children,
  userId,
  enabled = true,
  debug = process.env.NODE_ENV === 'development',
  endpoint,
}: AnalyticsProviderProps) {
  // 初始化 tracker
  useEffect(() => {
    const tracker = getTracker({
      enabled,
      debug,
      endpoint,
      userId,
    })
    
    // 组件卸载时清理
    return () => {
      tracker.destroy()
    }
  }, [enabled, debug, endpoint, userId])

  return (
    <>
      <Suspense fallback={null}>
        <AnalyticsTracker userId={userId} />
      </Suspense>
      {children}
    </>
  )
}
