'use client'

import { useReportWebVitals } from 'next/web-vitals'
import { useCallback } from 'react'
import { perfLogger } from '@/lib/utils/logger'

/**
 * Web Vitals 性能监控组件
 *
 * 监控核心 Web Vitals 指标:
 * - LCP (Largest Contentful Paint): 最大内容绘制时间
 * - FID (First Input Delay): 首次输入延迟
 * - CLS (Cumulative Layout Shift): 累积布局偏移
 * - FCP (First Contentful Paint): 首次内容绘制
 * - TTFB (Time to First Byte): 首字节时间
 * - INP (Interaction to Next Paint): 交互到下一次绘制
 */
export function WebVitals() {
  const reportVital = useCallback(
    (metric: {
      id: string
      name: string
      value: number
      rating: 'good' | 'needs-improvement' | 'poor'
      delta: number
      entries: PerformanceEntry[]
      navigationType: string
    }) => {
      const { name, value, rating, id, delta } = metric

      // 记录到控制台（开发环境）
      const logFn = rating === 'poor' ? perfLogger.warn : rating === 'needs-improvement' ? perfLogger.info : perfLogger.debug
      logFn.call(perfLogger, `${name}: ${value.toFixed(2)}ms (${rating})`, {
        id,
        delta: delta.toFixed(2),
      })

      // 发送到 Sentry（生产环境）
      if (typeof window !== 'undefined' && process.env.NODE_ENV === 'production') {
        import('@sentry/nextjs').then((Sentry) => {
          // 添加 breadcrumb 记录 Web Vitals
          Sentry.addBreadcrumb({
            category: 'web-vitals',
            message: `${name}: ${value.toFixed(2)}${name === 'CLS' ? '' : 'ms'} (${rating})`,
            level: rating === 'poor' ? 'warning' : 'info',
            data: {
              value,
              rating,
              pathname: window.location.pathname,
            },
          })

          // 对于差的指标，设置 tag 以便追踪
          if (rating === 'poor') {
            Sentry.setTag(`poor_${name.toLowerCase()}`, 'true')
          }
        }).catch(() => {
          // Sentry not available
        })
      }

      // 发送到自定义分析端点（可选）
      if (process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT) {
        const body = JSON.stringify({
          name,
          value,
          rating,
          id,
          delta,
          pathname: typeof window !== 'undefined' ? window.location.pathname : '',
          timestamp: Date.now(),
        })

        // 使用 sendBeacon 确保数据在页面卸载时也能发送
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
          navigator.sendBeacon(process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT, body)
        } else {
          fetch(process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT, {
            method: 'POST',
            body,
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
          }).catch(() => {
            // Ignore analytics errors
          })
        }
      }
    },
    []
  )

  useReportWebVitals(reportVital)

  return null
}

/**
 * Web Vitals 阈值（毫秒）
 * 基于 Google Core Web Vitals 标准
 */
export const WEB_VITALS_THRESHOLDS = {
  LCP: { good: 2500, poor: 4000 },
  FID: { good: 100, poor: 300 },
  CLS: { good: 0.1, poor: 0.25 },
  FCP: { good: 1800, poor: 3000 },
  TTFB: { good: 800, poor: 1800 },
  INP: { good: 200, poor: 500 },
} as const

/**
 * 获取指标评级
 */
export function getMetricRating(
  name: keyof typeof WEB_VITALS_THRESHOLDS,
  value: number
): 'good' | 'needs-improvement' | 'poor' {
  const thresholds = WEB_VITALS_THRESHOLDS[name]
  if (value <= thresholds.good) return 'good'
  if (value <= thresholds.poor) return 'needs-improvement'
  return 'poor'
}

export default WebVitals
