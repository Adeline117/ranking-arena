'use client'

import { SWRConfig } from 'swr'
import { ReactNode } from 'react'
import { fetcher } from './useSWR'
import { logger } from '@/lib/logger'

/**
 * 全局 SWR 配置 Provider
 * 统一配置所有 SWR hooks 的默认行为
 */
export function SWRConfigProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        // 使用统一的 fetcher
        fetcher,
        
        // 性能优化配置
        revalidateOnFocus: false, // 窗口聚焦时不自动重新验证，减少不必要的请求
        revalidateOnReconnect: true, // 网络重连时重新验证
        
        // 去重配置 - 增加去重时间，减少重复请求
        dedupingInterval: 5000, // 5 秒内相同请求会被去重
        
        // 错误重试配置
        errorRetryCount: 2, // 最多重试 2 次，避免长时间等待
        errorRetryInterval: 3000, // 重试间隔 3 秒
        
        // 智能重试 - 只对网络错误和服务器错误重试
        shouldRetryOnError: (error) => {
          // 429 rate limit — retry after backoff (server-side throttling is transient)
          if (error?.status === 429) return true
          // 不对其他 4xx 客户端错误重试（如 401, 403, 404）
          if (error?.status >= 400 && error?.status < 500) {
            return false
          }
          // 对网络错误和 5xx 服务器错误重试
          return true
        },
        
        // 错误处理
        onError: (error, key) => {
          // 不上报 4xx 错误（用户侧问题）
          const status = error?.status || error?.response?.status
          if (status && status >= 400 && status < 500) return
          
          if (process.env.NODE_ENV === 'production') {
            logger.error('SWR Error:', { key, error })
             
            import('@sentry/nextjs').then((Sentry) => {
              Sentry.captureException(error, {
                tags: { source: 'swr', swr_key: String(key) },
                level: 'warning',
              })
            }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget, failure is non-critical
          }
        },
        
        // 加载慢速网络检测
        loadingTimeout: 3000, // 3 秒后认为加载过慢
        
        // 保持数据新鲜度
        keepPreviousData: true, // 在重新验证时保持旧数据，避免闪烁
      }}
    >
      {children}
    </SWRConfig>
  )
}
