/**
 * 统一的错误处理工具函数
 * 将原始错误信息转换为用户友好的中文提示
 */

import { t } from '@/lib/i18n'

// 错误类型定义
export interface ErrorInfo {
  type: 'network' | 'timeout' | 'server' | 'validation' | 'auth' | 'unknown'
  message: string
  originalError?: Error | unknown
  code?: string | number
}

// 网络错误检测
function isNetworkError(error: any): boolean {
  if (!error) return false
  
  // 检查常见的网络错误标识
  const errorMessage = String(error.message || error).toLowerCase()
  const networkErrorPatterns = [
    'network',
    'fetch',
    'connection',
    'offline',
    'internet',
    'dns',
    'host',
    'unreachable',
    'abort',
    'cors'
  ]
  
  return networkErrorPatterns.some(pattern => errorMessage.includes(pattern))
}

// 超时错误检测
function isTimeoutError(error: any): boolean {
  if (!error) return false
  
  const errorMessage = String(error.message || error).toLowerCase()
  const timeoutPatterns = ['timeout', 'timed out', 'deadline', 'request took too long']
  
  return timeoutPatterns.some(pattern => errorMessage.includes(pattern))
}

// 服务器错误检测  
function isServerError(error: any): boolean {
  if (!error) return false
  
  // 检查HTTP状态码
  const status = error.status || error.code || error.response?.status
  if (typeof status === 'number' && status >= 500) {
    return true
  }
  
  // 检查错误消息
  const errorMessage = String(error.message || error).toLowerCase()
  const serverErrorPatterns = [
    'server error',
    'internal server',
    '500',
    '502',
    '503',
    '504',
    'service unavailable',
    'bad gateway'
  ]
  
  return serverErrorPatterns.some(pattern => errorMessage.includes(pattern))
}

// 认证错误检测
function isAuthError(error: any): boolean {
  if (!error) return false
  
  const status = error.status || error.code || error.response?.status
  if (status === 401 || status === 403) {
    return true
  }
  
  const errorMessage = String(error.message || error).toLowerCase()
  const authErrorPatterns = [
    'unauthorized',
    'forbidden',
    'authentication',
    'permission',
    'access denied',
    'token',
    'login'
  ]
  
  return authErrorPatterns.some(pattern => errorMessage.includes(pattern))
}

// 验证错误检测
function isValidationError(error: any): boolean {
  if (!error) return false
  
  const status = error.status || error.code || error.response?.status
  if (status === 400 || status === 422) {
    return true
  }
  
  const errorMessage = String(error.message || error).toLowerCase()
  const validationErrorPatterns = [
    'validation',
    'invalid',
    'required',
    'format',
    'bad request'
  ]
  
  return validationErrorPatterns.some(pattern => errorMessage.includes(pattern))
}

/**
 * 解析错误并返回友好的错误信息
 */
export function parseError(error: any): ErrorInfo {
  if (!error) {
    return {
      type: 'unknown',
      message: t('unknownErrorFriendly')
    }
  }

  // 网络错误
  if (isNetworkError(error)) {
    return {
      type: 'network',
      message: t('networkErrorFriendly'),
      originalError: error
    }
  }

  // 超时错误
  if (isTimeoutError(error)) {
    return {
      type: 'timeout', 
      message: t('networkTimeoutFriendly'),
      originalError: error
    }
  }

  // 服务器错误
  if (isServerError(error)) {
    return {
      type: 'server',
      message: t('serverErrorFriendly'),
      originalError: error,
      code: error.status || error.code || error.response?.status
    }
  }

  // 认证错误
  if (isAuthError(error)) {
    return {
      type: 'auth',
      message: t('authenticationFailed'),
      originalError: error,
      code: error.status || error.code || error.response?.status
    }
  }

  // 验证错误
  if (isValidationError(error)) {
    return {
      type: 'validation',
      message: error.message || t('operationFailed'),
      originalError: error,
      code: error.status || error.code || error.response?.status
    }
  }

  // 未知错误
  return {
    type: 'unknown',
    message: t('unknownErrorFriendly'),
    originalError: error
  }
}

/**
 * 获取友好的错误消息
 */
export function getErrorMessage(error: any): string {
  return parseError(error).message
}

/**
 * 判断错误是否可重试
 */
export function isRetryableError(error: any): boolean {
  const errorInfo = parseError(error)
  
  // 网络错误、超时错误、服务器错误通常可以重试
  return ['network', 'timeout', 'server'].includes(errorInfo.type)
}

/**
 * 错误上报到 Sentry（如果可用）
 */
export function reportError(error: any, context?: Record<string, any>) {
  const errorInfo = parseError(error)
  
  // 只上报服务器错误和未知错误
  // 不上报: 网络错误(用户网络问题)、超时、认证(401/403)、验证(400)
  if (!['unknown', 'server'].includes(errorInfo.type)) {
    return
  }
  
  // 延迟加载 Sentry
  if (typeof window !== 'undefined') {
    import('@sentry/nextjs').then((Sentry) => {
      Sentry.captureException(errorInfo.originalError || error, {
        level: errorInfo.type === 'server' ? 'error' : 'warning',
        tags: {
          errorType: errorInfo.type,
          errorCode: String(errorInfo.code || 'unknown'),
          source: context?.source as string || 'client',
        },
        contexts: {
          errorInfo: {
            type: errorInfo.type,
            message: errorInfo.message,
            code: errorInfo.code,
          },
          additional: context
        },
        fingerprint: errorInfo.code
          ? ['{{ default }}', String(errorInfo.code)]
          : ['{{ default }}'],
      })
    }).catch(() => {
      // Sentry 加载失败时静默处理
    })
  }
}

/**
 * 处理 API 响应错误
 */
export function handleApiError(error: any): never {
  const errorInfo = parseError(error)
  reportError(error, { source: 'api' })
  throw new Error(errorInfo.message)
}

/**
 * 封装 fetch 请求，自动处理错误
 */
export async function safeFetch(
  url: string, 
  options?: RequestInit,
  retries: number = 1
): Promise<Response> {
  let lastError: any
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30000), // 30秒超时
      })
      
      if (!response.ok) {
        const errorData = await response.text().catch(() => response.statusText)
        const error = new Error(errorData || `HTTP ${response.status}`)
        ;(error as Error & { status?: number }).status = response.status
        throw error
      }
      
      return response
    } catch (error) {
      lastError = error
      
      // 如果不可重试或已达到最大重试次数，抛出错误
      if (!isRetryableError(error) || attempt === retries) {
        break
      }
      
      // 重试前等待一段时间
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
    }
  }
  
  handleApiError(lastError)
}

/**
 * 创建错误处理的 React Hook
 */
export function createErrorHandler(onError?: (errorInfo: ErrorInfo) => void) {
  return (error: any, context?: Record<string, any>) => {
    const errorInfo = parseError(error)
    reportError(error, context)
    
    if (onError) {
      onError(errorInfo)
    } else {
      // 默认行为：在控制台记录错误
      console.error('Handled error:', errorInfo)
    }
  }
}

const errorHandling = {
  parseError,
  getErrorMessage,
  isRetryableError,
  reportError,
  handleApiError,
  safeFetch,
  createErrorHandler,
}
export default errorHandling