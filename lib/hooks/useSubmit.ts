'use client'

import { useState, useCallback, useRef } from 'react'

interface UseSubmitOptions {
  /** 防抖延迟（毫秒） */
  debounceMs?: number
  /** 成功后的回调 */
  onSuccess?: (result: unknown) => void
  /** 失败后的回调 */
  onError?: (error: Error) => void
  /** 是否在执行中显示 Toast */
  showToast?: boolean
}

interface UseSubmitReturn<T> {
  /** 是否正在提交 */
  isSubmitting: boolean
  /** 上次提交的结果 */
  result: T | null
  /** 上次提交的错误 */
  error: Error | null
  /** 提交函数 */
  submit: (...args: unknown[]) => Promise<T | null>
  /** 重置状态 */
  reset: () => void
}

/**
 * 防重复提交 Hook
 * 在异步操作执行期间自动阻止重复调用
 * 
 * @example
 * ```tsx
 * const { isSubmitting, submit, error } = useSubmit(
 *   async (data) => {
 *     const response = await fetch('/api/post', {
 *       method: 'POST',
 *       body: JSON.stringify(data),
 *     })
 *     return response.json()
 *   },
 *   { debounceMs: 300 }
 * )
 * 
 * <Button onClick={() => submit({ title: 'Hello' })} loading={isSubmitting}>
 *   提交
 * </Button>
 * ```
 */
export function useSubmit<T>(
  fn: (...args: unknown[]) => Promise<T>,
  options: UseSubmitOptions = {}
): UseSubmitReturn<T> {
  const {
    debounceMs = 300,
    onSuccess,
    onError,
  } = options

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [result, setResult] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  
  const lastCallTime = useRef<number>(0)
  const abortControllerRef = useRef<AbortController | null>(null)

  const submit = useCallback(async (...args: unknown[]): Promise<T | null> => {
    const now = Date.now()
    
    // 防抖检查
    if (now - lastCallTime.current < debounceMs) {
      return null
    }
    
    // 如果已经在提交中，忽略
    if (isSubmitting) {
      return null
    }

    lastCallTime.current = now
    setIsSubmitting(true)
    setError(null)

    // 取消之前的请求（如果支持）
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()

    try {
      const res = await fn(...args)
      setResult(res)
      onSuccess?.(res)
      return res
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      
      // 忽略取消的请求
      if (error.name === 'AbortError') {
        return null
      }
      
      setError(error)
      onError?.(error)
      return null
    } finally {
      setIsSubmitting(false)
    }
  }, [fn, debounceMs, isSubmitting, onSuccess, onError])

  const reset = useCallback(() => {
    setIsSubmitting(false)
    setResult(null)
    setError(null)
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  return {
    isSubmitting,
    result,
    error,
    submit,
    reset,
  }
}

/**
 * 简化版防重复点击 Hook
 * 用于简单的点击操作防抖
 */
export function useDebounceClick(
  onClick: () => void | Promise<void>,
  delayMs: number = 300
) {
  const [isDisabled, setIsDisabled] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleClick = useCallback(async () => {
    if (isDisabled) return

    setIsDisabled(true)
    
    try {
      await onClick()
    } finally {
      timeoutRef.current = setTimeout(() => {
        setIsDisabled(false)
      }, delayMs)
    }
  }, [onClick, delayMs, isDisabled])

  // 清理
  const cleanup = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
  }, [])

  return { handleClick, isDisabled, cleanup }
}

export default useSubmit

