/**
 * 统一的异步操作 Hook
 * 处理 loading 状态、防重复点击、超时保护、错误处理
 */

import { useState, useRef, useCallback } from 'react'

export interface AsyncActionOptions<T> {
  /** 超时时间 (ms)，默认 10000 */
  timeout?: number
  /** 成功回调 */
  onSuccess?: (result: T) => void
  /** 失败回调 */
  onError?: (error: Error) => void
  /** 是否使用乐观更新 */
  optimisticUpdate?: () => void
  /** 乐观更新回滚 */
  rollback?: () => void
}

export interface AsyncActionReturn<T, Args extends unknown[]> {
  /** 执行异步操作 */
  execute: (...args: Args) => Promise<T | null>
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
  /** 清除错误 */
  clearError: () => void
  /** 重置状态 */
  reset: () => void
}

/**
 * 统一的异步操作 Hook
 *
 * @example
 * const { execute, isLoading, error } = useAsyncAction(
 *   async (traderId: string) => {
 *     const response = await fetch(`/api/follow`, { method: 'POST' })
 *     return response.json()
 *   },
 *   {
 *     timeout: 5000,
 *     onSuccess: () => showToast('关注成功'),
 *     onError: (e) => showToast(e.message, 'error'),
 *   }
 * )
 */
export function useAsyncAction<T, Args extends unknown[] = []>(
  action: (...args: Args) => Promise<T>,
  options: AsyncActionOptions<T> = {}
): AsyncActionReturn<T, Args> {
  const {
    timeout = 10000,
    onSuccess,
    onError,
    optimisticUpdate,
    rollback,
  } = options

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 防重复点击
  const pendingRef = useRef(false)
  // AbortController 用于超时和取消
  const abortControllerRef = useRef<AbortController | null>(null)

  const clearError = useCallback(() => setError(null), [])

  const reset = useCallback(() => {
    setIsLoading(false)
    setError(null)
    pendingRef.current = false
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
  }, [])

  const execute = useCallback(
    async (...args: Args): Promise<T | null> => {
      // 防重复点击
      if (pendingRef.current) {
        return null
      }

      pendingRef.current = true
      setIsLoading(true)
      setError(null)

      // 创建 AbortController 用于超时
      const abortController = new AbortController()
      abortControllerRef.current = abortController

      // 设置超时
      const timeoutId = setTimeout(() => {
        abortController.abort()
      }, timeout)

      // 乐观更新
      if (optimisticUpdate) {
        optimisticUpdate()
      }

      try {
        const result = await action(...args)

        // 检查是否已取消
        if (abortController.signal.aborted) {
          return null
        }

        clearTimeout(timeoutId)
        onSuccess?.(result)
        return result
      } catch (err) {
        clearTimeout(timeoutId)

        // 回滚乐观更新
        if (rollback) {
          rollback()
        }

        // 处理错误
        let errorMessage: string

        if (err instanceof Error) {
          if (err.name === 'AbortError') {
            errorMessage = '请求超时，请稍后重试'
          } else {
            errorMessage = err.message
          }
        } else {
          errorMessage = '操作失败，请稍后重试'
        }

        setError(errorMessage)
        onError?.(err instanceof Error ? err : new Error(errorMessage))
        return null
      } finally {
        setIsLoading(false)
        pendingRef.current = false
        abortControllerRef.current = null
      }
    },
    [action, timeout, onSuccess, onError, optimisticUpdate, rollback, clearError]
  )

  return {
    execute,
    isLoading,
    error,
    clearError,
    reset,
  }
}

/**
 * 简化版本：只需要 loading 和防重复
 */
export function useLoadingAction<T, Args extends unknown[] = []>(
  action: (...args: Args) => Promise<T>
): {
  execute: (...args: Args) => Promise<T | null>
  isLoading: boolean
} {
  const { execute, isLoading } = useAsyncAction(action)
  return { execute, isLoading }
}
