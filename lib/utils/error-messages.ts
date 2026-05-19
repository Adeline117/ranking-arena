/**
 * Unified error message handling.
 * Converts various errors into user-friendly messages via i18n.
 */

import { t } from '@/lib/i18n'

export type ErrorType =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'rate_limit'
  | 'server_error'
  | 'service_unavailable'
  | 'unknown'

export interface ParsedError {
  type: ErrorType
  message: string
  retryable: boolean
  statusCode?: number
}

/**
 * Default error messages — resolved at call time via i18n so they respect the current language.
 */
function getDefaultErrorMessage(type: ErrorType): string {
  const map: Record<ErrorType, () => string> = {
    network: () => t('errorNetworkFailed'),
    timeout: () => t('errorTimeout'),
    unauthorized: () => t('errorUnauthorized'),
    forbidden: () => t('errorForbidden'),
    not_found: () => t('errorNotFound'),
    validation: () => t('errorValidation'),
    rate_limit: () => t('errorRateLimit'),
    server_error: () => t('errorServerError'),
    service_unavailable: () => t('errorServiceUnavailable'),
    unknown: () => t('errorUnknown'),
  }
  return map[type]()
}

/**
 * HTTP 状态码到错误类型映射
 */
const STATUS_CODE_MAP: Record<number, ErrorType> = {
  400: 'validation',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  408: 'timeout',
  429: 'rate_limit',
  500: 'server_error',
  502: 'server_error',
  503: 'service_unavailable',
  504: 'timeout',
}

/**
 * 解析错误并返回结构化错误信息
 */
export function parseError(error: unknown): ParsedError {
  // AbortError (超时或取消)
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      type: 'timeout',
      message: getDefaultErrorMessage('timeout'),
      retryable: true,
    }
  }

  // 网络错误
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return {
      type: 'network',
      message: getDefaultErrorMessage('network'),
      retryable: true,
    }
  }

  // Response 错误 (带 status 的对象)
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    const type = STATUS_CODE_MAP[status] || 'unknown'
    return {
      type,
      message: getDefaultErrorMessage(type),
      retryable: [408, 500, 502, 503, 504].includes(status),
      statusCode: status,
    }
  }

  // Error 对象
  if (error instanceof Error) {
    const message = error.message.toLowerCase()

    // 网络相关
    if (
      message.includes('network') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('failed to fetch')
    ) {
      return {
        type: 'network',
        message: getDefaultErrorMessage('network'),
        retryable: true,
      }
    }

    // 超时
    if (message.includes('timeout') || message.includes('timed out')) {
      return {
        type: 'timeout',
        message: getDefaultErrorMessage('timeout'),
        retryable: true,
      }
    }

    // 限流 — NOT retryable: retrying amplifies the problem (each retry
    // also counts against the limit, creating a cascade)
    if (message.includes('rate limit') || message.includes('too many')) {
      return {
        type: 'rate_limit',
        message: getDefaultErrorMessage('rate_limit'),
        retryable: false,
      }
    }

    // 权限
    if (message.includes('unauthorized') || message.includes('not logged in')) {
      return {
        type: 'unauthorized',
        message: getDefaultErrorMessage('unauthorized'),
        retryable: false,
      }
    }

    if (message.includes('forbidden') || message.includes('no permission')) {
      return {
        type: 'forbidden',
        message: getDefaultErrorMessage('forbidden'),
        retryable: false,
      }
    }

    // 使用原始错误消息（如果不是太长）
    if (error.message && error.message.length < 100) {
      return {
        type: 'unknown',
        message: error.message,
        retryable: false,
      }
    }
  }

  // 未知错误
  return {
    type: 'unknown',
    message: getDefaultErrorMessage('unknown'),
    retryable: false,
  }
}

/**
 * 获取用户友好的错误消息
 */
export function getErrorMessage(error: unknown): string {
  return parseError(error).message
}

/**
 * 判断错误是否可重试
 */
export function isRetryableError(error: unknown): boolean {
  return parseError(error).retryable
}

/**
 * 判断是否需要重新登录
 */
export function isAuthError(error: unknown): boolean {
  const parsed = parseError(error)
  return parsed.type === 'unauthorized' || parsed.type === 'forbidden'
}

/**
 * 带超时的 fetch 包装
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 10000
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 安全的 JSON 请求封装
 */
export async function safeJsonFetch<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 10000
): Promise<{ data: T | null; error: ParsedError | null }> {
  try {
    const response = await fetchWithTimeout(url, options, timeoutMs)

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}))
      return {
        data: null,
        error: {
          type: STATUS_CODE_MAP[response.status] || 'unknown',
          message:
            errorBody.error ||
            errorBody.message ||
            getDefaultErrorMessage(STATUS_CODE_MAP[response.status] || 'unknown'),
          retryable: [408, 500, 502, 503, 504].includes(response.status),
          statusCode: response.status,
        },
      }
    }

    const data = await response.json()
    return { data, error: null }
  } catch (error) {
    return { data: null, error: parseError(error) }
  }
}
