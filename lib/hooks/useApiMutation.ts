/**
 * useApiMutation - 统一的 API 请求 Hook
 * 
 * 功能:
 * - 自动处理 loading 状态
 * - 统一错误处理和 toast 提示
 * - 支持重试机制
 * - 防止重复提交
 * - TypeScript 类型安全
 */

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
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  VALIDATION_ERROR: '输入数据有误',
  NETWORK_ERROR: '网络错误，请检查网络连接',
  TABLE_NOT_FOUND: '功能暂未开放',
  LIMIT_REACHED: '已达到限制',
  CSRF_INVALID: '安全验证失败，请刷新页面重试',
  SERVER_ERROR: '服务器错误，请稍后重试',
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
  if (error.code && ERROR_MESSAGES[error.code]) {
    return ERROR_MESSAGES[error.code]
  }
  
  // 特殊错误处理
  if (error.tableNotFound) {
    return ERROR_MESSAGES.TABLE_NOT_FOUND
  }
  if (error.limitReached) {
    return ERROR_MESSAGES.LIMIT_REACHED
  }
  
  // 返回原始消息或默认消息
  return error.message || '操作失败，请重试'
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

          attempt++
          if (attempt <= retryCount) {
            await delay(retryDelay * attempt)
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
    } catch {
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
