import { logger } from '@/lib/logger'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
/**
 * 客户端 API 请求工具
 * 自动处理 CSRF Token 和通用配置
 */

const CSRF_COOKIE_NAME = 'csrf-token'
const CSRF_HEADER_NAME = 'x-csrf-token'

/**
 * 从 Cookie 中获取 CSRF Token
 */
function getCsrfTokenFromCookie(): string | null {
  if (typeof document === 'undefined') return null
  
  const cookies = document.cookie.split(';')
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=')
    if (name === CSRF_COOKIE_NAME) {
      return decodeURIComponent(value)
    }
  }
  return null
}

/**
 * 设置 CSRF Token Cookie
 */
function setCsrfTokenCookie(token: string): void {
  if (typeof document === 'undefined') return
  
  const isProduction = process.env.NODE_ENV === 'production'
  const maxAge = 24 * 60 * 60 // 24 小时（秒）
  
  let cookieString = `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`
  cookieString += `; path=/`
  cookieString += `; max-age=${maxAge}`
  cookieString += `; samesite=strict`
  
  if (isProduction) {
    cookieString += `; secure`
  }
  
  document.cookie = cookieString
}

/**
 * 生成客户端 CSRF Token
 */
function generateClientCsrfToken(): string {
  const timestamp = Date.now().toString(36)
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `${timestamp}.${randomPart}`
}

/**
 * 确保 CSRF Token 存在
 */
function ensureCsrfToken(): string | null {
  if (typeof document === 'undefined') return null
  
  let token = getCsrfTokenFromCookie()
  
  if (!token) {
    token = generateClientCsrfToken()
    setCsrfTokenCookie(token)
  }
  
  return token
}

/**
 * API 请求配置
 */
type ApiRequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number
  /** Number of retry attempts for retryable errors (default: 0) */
  retries?: number
  /** Base delay between retries in ms, doubles each attempt (default: 1000) */
  retryBaseDelayMs?: number
}

/**
 * API 响应类型
 */
type ApiResponse<T = unknown> = {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: unknown
    retryable?: boolean
    retryAfter?: number
  }
}

/**
 * 封装的 API 请求函数
 * 自动添加 CSRF Token 和通用 headers
 */
export async function apiRequest<T = unknown>(
  url: string,
  options: ApiRequestOptions = {}
): Promise<ApiResponse<T>> {
  const {
    body,
    headers: customHeaders,
    timeoutMs = 30_000,
    retries = 0,
    retryBaseDelayMs = 1000,
    ...restOptions
  } = options

  // 构建 headers
  const headers = new Headers(customHeaders)
  
  // 添加 Content-Type（如果有 body 且未设置）
  if (body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  
  // 添加 CSRF Token（对于状态修改请求）
  const method = (options.method || 'GET').toUpperCase()
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const csrfToken = ensureCsrfToken()
    if (csrfToken) {
      headers.set(CSRF_HEADER_NAME, csrfToken)
    }
  }

  let lastResult: ApiResponse<T> | undefined

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Wait before retry (exponential backoff)
    if (attempt > 0 && lastResult?.error) {
      const delay = lastResult.error.retryAfter
        ? lastResult.error.retryAfter * 1000
        : retryBaseDelayMs * Math.pow(2, attempt - 1)
      await new Promise(r => setTimeout(r, delay))
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        ...restOptions,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'include',
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      const data = await response.json()

      if (!response.ok) {
        // Extract retry-after header if present
        const retryAfterHeader = response.headers.get('Retry-After')
        let retryAfter: number | undefined
        if (retryAfterHeader) {
          retryAfter = parseInt(retryAfterHeader, 10)
          if (isNaN(retryAfter)) {
            const retryDate = Date.parse(retryAfterHeader)
            if (!isNaN(retryDate)) {
              retryAfter = Math.ceil((retryDate - Date.now()) / 1000)
            }
          }
        }

        const isRateLimited = response.status === 429 || isProviderRateLimitResponse(data)
        const isRetryable = isRateLimited || [500, 502, 503, 504].includes(response.status)

        if (!retryAfter && data?.error?.details?.retryAfter) {
          retryAfter = data.error.details.retryAfter
        }

        lastResult = {
          success: false,
          error: {
            code: isRateLimited ? 'RATE_LIMITED' : (data.error?.code || 'REQUEST_FAILED'),
            message: data.error?.message || data.message || (isRateLimited ? '请求频率超限' : '请求失败'),
            details: data.error?.details,
            retryable: isRetryable,
            retryAfter,
          },
        }

        // Only retry if retryable
        if (isRetryable && attempt < retries) continue
        return lastResult
      }

      return { success: true, data: data as T }
    } catch (error: unknown) {
      clearTimeout(timeoutId)

      const isAbort = error instanceof DOMException && error.name === 'AbortError'
      lastResult = {
        success: false,
        error: {
          code: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
          message: isAbort ? '请求超时，请稍后重试' : '网络错误，请检查网络连接',
          retryable: true,
        },
      }

      if (attempt < retries) continue

      logger.error('API 请求错误:', error)
      return lastResult
    }
  }

  // Should never reach here, but TypeScript needs it
  return lastResult!
}

/**
 * Check if a response indicates a provider rate limit error
 */
function isProviderRateLimitResponse(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false

  const obj = data as Record<string, unknown>
  const error = typeof obj.error === 'object' && obj.error !== null
    ? (obj.error as Record<string, unknown>)
    : obj

  if (error.type !== 'provider' || error.reason !== 'provider_error') {
    return false
  }

  const message = String(error.message || '').toLowerCase()
  if (message.includes('rate limit') || message.includes('rate_limit')) {
    return true
  }

  const provider = typeof error.provider === 'object' && error.provider !== null
    ? (error.provider as Record<string, unknown>)
    : null
  return provider?.status === 429
}

/**
 * GET 请求
 */
export async function apiGet<T = unknown>(
  url: string,
  options?: Omit<ApiRequestOptions, 'method' | 'body'>
): Promise<ApiResponse<T>> {
  return apiRequest<T>(url, { ...options, method: 'GET' })
}

/**
 * POST 请求
 */
export async function apiPost<T = unknown>(
  url: string,
  body?: unknown,
  options?: Omit<ApiRequestOptions, 'method' | 'body'>
): Promise<ApiResponse<T>> {
  return apiRequest<T>(url, { ...options, method: 'POST', body })
}

/**
 * PUT 请求
 */
export async function apiPut<T = unknown>(
  url: string,
  body?: unknown,
  options?: Omit<ApiRequestOptions, 'method' | 'body'>
): Promise<ApiResponse<T>> {
  return apiRequest<T>(url, { ...options, method: 'PUT', body })
}

/**
 * DELETE 请求
 */
export async function apiDelete<T = unknown>(
  url: string,
  options?: Omit<ApiRequestOptions, 'method'>
): Promise<ApiResponse<T>> {
  return apiRequest<T>(url, { ...options, method: 'DELETE' })
}

/**
 * PATCH 请求
 */
export async function apiPatch<T = unknown>(
  url: string,
  body?: unknown,
  options?: Omit<ApiRequestOptions, 'method' | 'body'>
): Promise<ApiResponse<T>> {
  return apiRequest<T>(url, { ...options, method: 'PATCH', body })
}

/**
 * 获取 CSRF Headers（用于需要自定义 fetch 的场景）
 */
export function getCsrfHeaders(): Record<string, string> {
  const token = ensureCsrfToken()
  if (!token) return {}
  return { [CSRF_HEADER_NAME]: token }
}

/**
 * Low-level fetch result used by authedFetch.
 */
export type FetchResult<T> = {
  ok: boolean
  status: number
  data: T | null
}

/**
 * Low-level authenticated fetch helper.
 *
 * Automatically includes:
 * - Authorization header (when accessToken is provided)
 * - CSRF headers (for mutating methods)
 * - Content-Type: application/json (for mutating methods)
 * - JSON response parsing
 * - 401 token refresh + retry via centralized coordinator
 *
 * Returns the raw HTTP status and parsed JSON, making it suitable
 * for hooks that need status-code-level control (e.g. mapping 401/429
 * to user-friendly messages) without the full ApiResponse wrapper.
 */
export async function authedFetch<T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  accessToken: string | null,
  body?: Record<string, unknown>,
): Promise<FetchResult<T>> {
  const headers: Record<string, string> = {}

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }

  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    Object.assign(headers, getCsrfHeaders())
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  // On 401 with an auth token, attempt refresh and retry once
  if (response.status === 401 && accessToken && typeof window !== 'undefined') {
    const newToken = await tokenRefreshCoordinator.forceRefresh()
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`
      const retryResponse = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })
      const retryData = await retryResponse.json().catch(() => {
        const ct = retryResponse.headers.get('content-type') || ''
        if (!ct.includes('application/json')) {
          logger.warn(`[api-client] Retry response is not JSON (status=${retryResponse.status}, content-type=${ct}), likely HTML error page`)
        }
        return null
      })
      return { ok: retryResponse.ok, status: retryResponse.status, data: retryData }
    }
  }

  const data = await response.json().catch(() => {
    const ct = response.headers.get('content-type') || ''
    if (!ct.includes('application/json')) {
      logger.warn(`[api-client] Response is not JSON (status=${response.status}, content-type=${ct}), likely HTML error page`)
    }
    return null
  })
  return { ok: response.ok, status: response.status, data }
}

/**
 * Map HTTP status codes to user-friendly error messages.
 *
 * Useful in hooks to convert status codes into localized
 * error strings without repeating the same switch/if logic.
 */
export function getHttpErrorMessage(status: number, fallback: string): string {
  if (status === 401) return '登录已过期，请重新登录'
  if (status === 403) return '权限不足'
  if (status === 429) return '操作太快，稍等一下'
  if (status >= 500) return '服务异常，请稍后重试'
  return fallback
}

/**
 * 初始化 CSRF Token（在应用启动时调用）
 */
export function initCsrfToken(): void {
  ensureCsrfToken()
}
