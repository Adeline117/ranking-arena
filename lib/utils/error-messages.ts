/**
 * 统一错误消息处理
 * 将各种错误转换为用户友好的消息
 */

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
 * 默认错误消息映射（中文）
 */
const DEFAULT_ERROR_MESSAGES: Record<ErrorType, string> = {
  network: '网络连接失败，请检查网络后重试',
  timeout: '请求超时，请稍后重试',
  unauthorized: '登录已过期，请重新登录',
  forbidden: '没有权限执行此操作',
  not_found: '请求的资源不存在',
  validation: '输入数据格式不正确',
  rate_limit: '操作太频繁，请稍后重试',
  server_error: '服务器错误，请稍后重试',
  service_unavailable: '服务暂时不可用，请稍后重试',
  unknown: '操作失败，请稍后重试',
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
      message: DEFAULT_ERROR_MESSAGES.timeout,
      retryable: true,
    }
  }

  // 网络错误
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return {
      type: 'network',
      message: DEFAULT_ERROR_MESSAGES.network,
      retryable: true,
    }
  }

  // Response 错误 (带 status 的对象)
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    const type = STATUS_CODE_MAP[status] || 'unknown'
    return {
      type,
      message: DEFAULT_ERROR_MESSAGES[type],
      retryable: [408, 429, 500, 502, 503, 504].includes(status),
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
        message: DEFAULT_ERROR_MESSAGES.network,
        retryable: true,
      }
    }

    // 超时
    if (message.includes('timeout') || message.includes('timed out')) {
      return {
        type: 'timeout',
        message: DEFAULT_ERROR_MESSAGES.timeout,
        retryable: true,
      }
    }

    // 限流
    if (message.includes('rate limit') || message.includes('too many')) {
      return {
        type: 'rate_limit',
        message: DEFAULT_ERROR_MESSAGES.rate_limit,
        retryable: true,
      }
    }

    // 权限
    if (message.includes('unauthorized') || message.includes('not logged in')) {
      return {
        type: 'unauthorized',
        message: DEFAULT_ERROR_MESSAGES.unauthorized,
        retryable: false,
      }
    }

    if (message.includes('forbidden') || message.includes('no permission')) {
      return {
        type: 'forbidden',
        message: DEFAULT_ERROR_MESSAGES.forbidden,
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
    message: DEFAULT_ERROR_MESSAGES.unknown,
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
          message: errorBody.error || errorBody.message || DEFAULT_ERROR_MESSAGES[STATUS_CODE_MAP[response.status] || 'unknown'],
          retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
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
