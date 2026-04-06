'use client'

import { useState, useCallback, useRef } from 'react'
import { apiRequest } from '@/lib/api/client'

// 错误类型定义
export type ApiError = {
  code: string
  message: string
  details?: unknown
  tableNotFound?: boolean
  limitReached?: boolean
  retryable?: boolean
  retryAfter?: number
}

// 配置选项
export type MutationOptions<TData, TVariables> = {
  // 成功回调
  onSuccess?: (data: TData, variables: TVariables) => void
  // 错误回调
  onError?: (error: ApiError, variables: TVariables) => void
  // 最终回调（无论成功失败）
  onSettled?: (data: TData | undefined, error: ApiError | undefined, variables: TVariables) => void
  // 成功提示消息
  successMessage?: string
  // 错误提示消息（覆盖默认）
  errorMessage?: string
  // 是否显示 toast 提示
  showToast?: boolean
  // 重试次数
  retryCount?: number
  // 重试延迟（毫秒）
  retryDelay?: number
}

// 返回类型
export type MutationResult<TData, TVariables> = {
  mutate: (variables: TVariables) => Promise<TData | undefined>
  mutateAsync: (variables: TVariables) => Promise<TData>
  isLoading: boolean
  isError: boolean
  isSuccess: boolean
  error: ApiError | null
  data: TData | null
  reset: () => void
}

// 已知错误代码的友好提示
const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: '请先登录',
  FORBIDDEN: '没有权限执行此操作',
  NOT_FOUND: '资源不存在',
  RATE_LIMITED: '请求频率超限，请稍后再试',
  RATE_LIMIT_EXCEEDED: '请求过于频繁，请稍后再试',
  PROVIDER_RATE_LIMIT: '服务请求频率超限，请稍后再试',
  TOO_MANY_REQUESTS: '请求次数过多，请稍后再试',
  VALIDATION_ERROR: '输入数据有误',
  NETWORK_ERROR: '网络错误，请检查网络连接',
  TABLE_NOT_FOUND: '功能暂未开放',
  LIMIT_REACHED: '已达到限制',
  CSRF_INVALID: '安全验证失败，请刷新页面重试',
  SERVER_ERROR: '服务器错误，请稍后重试',
  PROVIDER_ERROR: '外部服务暂时不可用，请稍后重试',
  EXTERNAL_SERVICE_ERROR: '外部服务错误，请稍后重试',
}

// Toast 函数类型（兼容现有 toast 系统）
type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void

// 全局 toast 引用（由 Provider 设置）
let globalShowToast: ToastFn | null = null

export function setGlobalToast(fn: ToastFn) {
  globalShowToast = fn
}

/**
 * 格式化错误消息
 */
function formatErrorMessage(error: ApiError, customMessage?: string): string {
  if (customMessage) return customMessage

  // 检查已知错误代码
  let baseMessage = error.message || '操作失败，请重试'
  if (error.code && ERROR_MESSAGES[error.code]) {
    baseMessage = ERROR_MESSAGES[error.code]
  }

  // 特殊错误处理
  if (error.tableNotFound) {
    return ERROR_MESSAGES.TABLE_NOT_FOUND
  }
  if (error.limitReached) {
    return ERROR_MESSAGES.LIMIT_REACHED
  }

  // Add retry information for rate limit errors
  if (isRateLimitError(error) && error.retryAfter) {
    const waitTime = formatWaitTime(error.retryAfter)
    return `${baseMessage}（${waitTime}后可重试）`
  }

  return baseMessage
}

/**
 * Check if an error is a rate limit error
 */
function isRateLimitError(error: ApiError): boolean {
  const rateLimitCodes = ['RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'PROVIDER_RATE_LIMIT', 'TOO_MANY_REQUESTS']
  return rateLimitCodes.includes(error.code)
}

/**
 * Format wait time for display
 */
function formatWaitTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}秒`
  }
  const minutes = Math.ceil(seconds / 60)
  return `${minutes}分钟`
}

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * useApiMutation Hook
 */
export function useApiMutation<TData = unknown, TVariables = void>(
  mutationFn: (variables: TVariables) => Promise<{ success: boolean; data?: TData; error?: ApiError }>,
  options: MutationOptions<TData, TVariables> = {}
): MutationResult<TData, TVariables> {
  const {
    onSuccess,
    onError,
    onSettled,
    successMessage,
    errorMessage,
    showToast = true,
    retryCount = 0,
    retryDelay = 1000,
  } = options

  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [data, setData] = useState<TData | null>(null)
  
  // 防止重复提交
  const isSubmittingRef = useRef(false)

  const showToastMessage = useCallback((message: string, type: 'success' | 'error' | 'warning' | 'info') => {
    if (showToast && globalShowToast) {
      globalShowToast(message, type)
    }
  }, [showToast])

  const reset = useCallback(() => {
    setIsLoading(false)
    setIsError(false)
    setIsSuccess(false)
    setError(null)
    setData(null)
  }, [])

  const mutateAsync = useCallback(async (variables: TVariables): Promise<TData> => {
    // 防止重复提交
    if (isSubmittingRef.current) {
      throw new Error('请勿重复提交')
    }

    isSubmittingRef.current = true
    setIsLoading(true)
    setIsError(false)
    setIsSuccess(false)
    setError(null)

    let lastError: ApiError | null = null
    let attempt = 0

    try {
      while (attempt <= retryCount) {
        try {
          const result = await mutationFn(variables)

          if (result.success && result.data !== undefined) {
            setData(result.data)
            setIsSuccess(true)
            
            if (successMessage) {
              showToastMessage(successMessage, 'success')
            }
            
            onSuccess?.(result.data, variables)
            onSettled?.(result.data, undefined, variables)
            
            return result.data
          }

          // 处理错误响应
          lastError = result.error || { code: 'UNKNOWN', message: '未知错误' }

          // 某些错误不应重试
          const noRetryErrors = ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_ERROR', 'CSRF_INVALID']
          if (noRetryErrors.includes(lastError.code)) {
            break
          }

          // Check if error is explicitly not retryable
          if (lastError.retryable === false) {
            break
          }

          attempt++
          if (attempt <= retryCount) {
            // Use retryAfter if available, otherwise use exponential backoff
            let waitTime = retryDelay * attempt
            if (isRateLimitError(lastError) && lastError.retryAfter) {
              // For rate limits, use the server-provided retry time (in seconds, convert to ms)
              // but cap it at a reasonable maximum
              waitTime = Math.min(lastError.retryAfter * 1000, 60000)
            }
            await delay(waitTime)
          }
        } catch (err) {
          lastError = {
            code: 'NETWORK_ERROR',
            message: err instanceof Error ? err.message : '网络错误',
          }
          
          attempt++
          if (attempt <= retryCount) {
            await delay(retryDelay * attempt)
          }
        }
      }

      // 所有重试都失败了
      setIsError(true)
      setError(lastError)
      
      const formattedMessage = formatErrorMessage(lastError!, errorMessage)
      showToastMessage(formattedMessage, 'error')
      
      onError?.(lastError!, variables)
      onSettled?.(undefined, lastError!, variables)
      
      throw lastError
    } finally {
      setIsLoading(false)
      isSubmittingRef.current = false
    }
  }, [mutationFn, retryCount, retryDelay, successMessage, errorMessage, showToastMessage, onSuccess, onError, onSettled])

  const mutate = useCallback(async (variables: TVariables): Promise<TData | undefined> => {
    try {
      return await mutateAsync(variables)
    } catch (_err) {
      /* expected: mutate swallows errors, callers use mutateAsync for throws */
      return undefined
    }
  }, [mutateAsync])

  return {
    mutate,
    mutateAsync,
    isLoading,
    isError,
    isSuccess,
    error,
    data,
    reset,
  }
}

/**
 * 便捷的 POST mutation 创建函数
 */
export function createPostMutation<TData = unknown, TBody = unknown>(url: string) {
  return (body: TBody) => apiRequest<TData>(url, { method: 'POST', body })
}

/**
 * 便捷的 DELETE mutation 创建函数
 */
export function createDeleteMutation<TData = unknown>(url: string) {
  return () => apiRequest<TData>(url, { method: 'DELETE' })
}

/**
 * 便捷的 PATCH mutation 创建函数
 */
export function createPatchMutation<TData = unknown, TBody = unknown>(url: string) {
  return (body: TBody) => apiRequest<TData>(url, { method: 'PATCH', body })
}
