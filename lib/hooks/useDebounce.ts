/**
 * useDebounce Hook
 * 用于延迟更新值，常用于搜索输入等场景
 */

import { useState, useEffect } from 'react'

/**
 * 延迟更新值的 Hook
 * @param value 需要延迟的值
 * @param delay 延迟时间（毫秒），默认 300ms
 * @returns 延迟后的值
 *
 * @example
 * ```tsx
 * const [query, setQuery] = useState('')
 * const debouncedQuery = useDebounce(query, 300)
 *
 * useEffect(() => {
 *   if (debouncedQuery) {
 *     fetchSearchResults(debouncedQuery)
 *   }
 * }, [debouncedQuery])
 * ```
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    // 设置定时器更新 debounced 值
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    // 清理定时器
    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])

  return debouncedValue
}

/**
 * 带回调的 debounce Hook
 * @param callback 需要延迟执行的回调函数
 * @param delay 延迟时间（毫秒），默认 300ms
 * @returns debounced 后的函数
 */
export function useDebouncedCallback<T extends (...args: unknown[]) => unknown>(
  callback: T,
  delay = 300
): T {
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [timeoutId])

  const debouncedFn = ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    const newTimeoutId = setTimeout(() => {
      callback(...args)
    }, delay)

    setTimeoutId(newTimeoutId)
  }) as T

  return debouncedFn
}
