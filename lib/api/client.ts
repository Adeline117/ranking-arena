import { logger } from '@/lib/logger'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { getViewerScope, isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import { bearerToken, jwtSubject } from '@/lib/auth/token-subject'
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
    .map((b) => b.toString(16).padStart(2, '0'))
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
  /** Request timeout in milliseconds (default: 20000) */
  timeoutMs?: number
  /** Number of retry attempts for retryable errors (default: 0) */
  retries?: number
  /** Base delay between retries in ms, doubles each attempt (default: 1000) */
  retryBaseDelayMs?: number
  /** Required when an opaque Authorization token cannot identify its owner. */
  authScope?: {
    expectedUserId: string
    sessionGeneration: number
  }
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

function staleAuthApiResponse<T>(): ApiResponse<T> {
  return {
    success: false,
    error: {
      code: 'STALE_AUTH_SCOPE',
      message: 'Authentication identity changed while the request was in flight',
      retryable: false,
    },
  }
}

function pendingAuthApiResponse<T>(): ApiResponse<T> {
  return {
    success: false,
    error: {
      code: 'AUTH_PENDING',
      message: 'Authentication is still being restored',
      retryable: true,
    },
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
    timeoutMs = 20_000,
    retries = 0,
    retryBaseDelayMs = 1000,
    authScope,
    ...restOptions
  } = options

  // 构建 headers
  const headers = new Headers(customHeaders)
  const currentScope = getViewerScope()
  const authorizationToken = bearerToken(headers.get('Authorization'))
  const authorizationUserId = jwtSubject(authorizationToken)
  const requestScope: ViewerScope = authScope
    ? {
        viewerKey: `user:${authScope.expectedUserId}`,
        sessionGeneration: authScope.sessionGeneration,
        userId: authScope.expectedUserId,
      }
    : authorizationUserId
      ? {
          viewerKey: `user:${authorizationUserId}`,
          sessionGeneration: currentScope.sessionGeneration,
          userId: authorizationUserId,
        }
      : currentScope
  // `credentials: include` means even a nominally public request can be
  // personalized by an auth cookie. In the browser every resolved viewer
  // scope (including anon) is therefore identity-bound.
  const isViewerBoundRequest = typeof window !== 'undefined'
  if (isViewerBoundRequest && requestScope.viewerKey === 'pending') {
    return pendingAuthApiResponse<T>()
  }
  if (
    isViewerBoundRequest &&
    authorizationToken &&
    ((!authScope && !authorizationUserId) ||
      (authScope && authorizationUserId && authorizationUserId !== authScope.expectedUserId))
  ) {
    return staleAuthApiResponse<T>()
  }
  if (isViewerBoundRequest && !isViewerScopeCurrent(requestScope)) {
    return staleAuthApiResponse<T>()
  }

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
  let hasAttempted401Refresh = false

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (isViewerBoundRequest && !isViewerScopeCurrent(requestScope)) {
      return staleAuthApiResponse<T>()
    }
    // Wait before retry (exponential backoff)
    if (attempt > 0 && lastResult?.error) {
      const delay = lastResult.error.retryAfter
        ? lastResult.error.retryAfter * 1000
        : retryBaseDelayMs * Math.pow(2, attempt - 1)
      await new Promise((r) => setTimeout(r, delay))
      if (isViewerBoundRequest && !isViewerScopeCurrent(requestScope)) {
        return staleAuthApiResponse<T>()
      }
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

      if (isViewerBoundRequest && !isViewerScopeCurrent(requestScope)) {
        return staleAuthApiResponse<T>()
      }

      if (!response.ok) {
        // 401 token refresh: attempt once, then retry the request
        if (response.status === 401 && !hasAttempted401Refresh && typeof window !== 'undefined') {
          hasAttempted401Refresh = true
          try {
            const newToken = await tokenRefreshCoordinator.forceRefresh({
              expectedUserId: requestScope.userId,
              sessionGeneration: requestScope.sessionGeneration,
            })
            if (newToken) {
              if (isViewerBoundRequest && !isViewerScopeCurrent(requestScope)) {
                return staleAuthApiResponse<T>()
              }
              // Retry the request with fresh credentials (cookies will be updated)
              if (headers.has('Authorization')) {
                headers.set('Authorization', `Bearer ${newToken}`)
              }
              const retryController = new AbortController()
              const retryTimeoutId = setTimeout(() => retryController.abort(), timeoutMs)
              try {
                const retryResponse = await fetch(url, {
                  ...restOptions,
                  headers,
                  body: body ? JSON.stringify(body) : undefined,
                  credentials: 'include',
                  signal: retryController.signal,
                })
                clearTimeout(retryTimeoutId)
                const retryData = await retryResponse.json()
                if (isViewerBoundRequest && !isViewerScopeCurrent(requestScope)) {
                  return staleAuthApiResponse<T>()
                }
                if (retryResponse.ok) {
                  return { success: true, data: retryData as T }
                }
                // If retry also failed, fall through to normal error handling
                // with the retry response instead
              } catch {
                clearTimeout(retryTimeoutId)
                // Fall through to return the original 401 error
              }
            }
          } catch {
            // Token refresh failed — fall through to return original 401
          }
        }

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

        // Normalize error: server returns either { error: "string" } or { error: { code, message } }
        const rawError = data?.error
        const errorIsObject = rawError && typeof rawError === 'object'
        const errorCode = isRateLimited
          ? 'RATE_LIMITED'
          : (errorIsObject ? rawError.code : null) || httpStatusToErrorCode(response.status)
        const errorMessage =
          (errorIsObject ? rawError.message : null) ||
          (typeof rawError === 'string' ? rawError : null) ||
          data?.message ||
          (isRateLimited ? '请求频率超限' : '请求失败')

        if (!retryAfter && errorIsObject && rawError.details?.retryAfter) {
          retryAfter = rawError.details.retryAfter
        }

        lastResult = {
          success: false,
          error: {
            code: errorCode,
            message: errorMessage,
            details: errorIsObject ? rawError.details : undefined,
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
  const error =
    typeof obj.error === 'object' && obj.error !== null
      ? (obj.error as Record<string, unknown>)
      : obj

  if (error.type !== 'provider' || error.reason !== 'provider_error') {
    return false
  }

  const message = String(error.message || '').toLowerCase()
  if (message.includes('rate limit') || message.includes('rate_limit')) {
    return true
  }

  const provider =
    typeof error.provider === 'object' && error.provider !== null
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
export type AuthedFetchScope = {
  expectedUserId?: string | null
  expectedSessionGeneration?: number
  signal?: AbortSignal
}

export type ScopedFetchResult<T> = FetchResult<T> & { stale?: boolean }

function captureFetchScope(accessToken: string | null, options?: AuthedFetchScope): ViewerScope {
  const current = getViewerScope()
  const expectedUserId = options?.expectedUserId ?? jwtSubject(accessToken) ?? current.userId
  return {
    viewerKey: expectedUserId ? `user:${expectedUserId}` : current.viewerKey,
    sessionGeneration: options?.expectedSessionGeneration ?? current.sessionGeneration,
    userId: expectedUserId,
  }
}

type BoundedRequestSignal = {
  cleanup: () => void
  signal: AbortSignal
}

/**
 * Compose caller cancellation with a cancelable deadline without relying on
 * AbortSignal.timeout/any. The native shell still supports iOS 15, where
 * those static helpers are absent, and a manual timer can be cleared as soon
 * as the complete request (including refresh/retry/body parsing) settles.
 */
function boundedRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): BoundedRequestSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('timeoutMs must be between 0 and 2147483647')
  }
  const controller = new AbortController()
  let cleaned = false
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    callerSignal?.removeEventListener('abort', abortFromCaller)
    controller.signal.removeEventListener('abort', cleanup)
  }

  const abortController = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }

  function abortFromCaller() {
    if (callerSignal) abortController(abortReason(callerSignal))
  }

  controller.signal.addEventListener('abort', cleanup, { once: true })
  if (callerSignal) {
    if (callerSignal.aborted) {
      abortFromCaller()
    } else {
      callerSignal.addEventListener('abort', abortFromCaller, { once: true })
    }
  }
  if (!controller.signal.aborted) {
    timeoutId = setTimeout(
      () => abortController(new DOMException('The operation timed out', 'TimeoutError')),
      Math.trunc(timeoutMs)
    )
  }

  return { cleanup, signal: controller.signal }
}

function consumePromise(work: Promise<unknown>): void {
  void work.then(
    () => undefined,
    () => undefined
  )
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function waitWithinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The work expression is evaluated before this helper is called. Always
    // observe it even when cancellation won the race, or its later rejection
    // would surface as an unhandled promise rejection.
    consumePromise(work)
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export async function authedFetch<T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  accessToken: string | null,
  body?: Record<string, unknown>,
  /** Request timeout in milliseconds (default: 15000 — mobile-friendly) */
  timeoutMs = 15_000,
  scopeOptions?: AuthedFetchScope
): Promise<ScopedFetchResult<T>> {
  const tokenUserId = jwtSubject(accessToken)
  if (
    accessToken &&
    scopeOptions?.expectedUserId !== undefined &&
    tokenUserId !== scopeOptions.expectedUserId
  ) {
    return { ok: false, status: 0, data: null, stale: true }
  }
  const requestScope = captureFetchScope(accessToken, scopeOptions)
  const scopeBound =
    scopeOptions?.expectedSessionGeneration !== undefined ||
    scopeOptions?.expectedUserId !== undefined ||
    requestScope.userId !== null
  if (scopeBound && !isViewerScopeCurrent(requestScope)) {
    return { ok: false, status: 0, data: null, stale: true }
  }
  const boundedRequest = boundedRequestSignal(scopeOptions?.signal, timeoutMs)
  const requestSignal = boundedRequest.signal

  try {
    if (requestSignal.aborted) return { ok: false, status: 0, data: null }

    const headers: Record<string, string> = {}

    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`
    }

    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'
      Object.assign(headers, getCsrfHeaders())
    }

    let response: Response
    try {
      if (requestSignal.aborted) return { ok: false, status: 0, data: null }
      response = await waitWithinSignal(
        fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store',
          signal: requestSignal,
        }),
        requestSignal
      )
    } catch (error) {
      if (
        requestSignal.aborted ||
        (error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError'))
      ) {
        // Convert cancellation into a structured FetchResult so callers get a
        // clear status instead of an unhandled exception.
        return { ok: false, status: 0, data: null }
      }
      throw error
    }

    // On 401 with an auth token, attempt refresh and retry once. Refresh,
    // retry transport, and body parsing all share the original deadline.
    if (response.status === 401 && accessToken && typeof window !== 'undefined') {
      if (scopeBound && !isViewerScopeCurrent(requestScope)) {
        return { ok: false, status: 0, data: null, stale: true }
      }
      if (requestSignal.aborted) return { ok: false, status: 0, data: null }
      let newToken: string | null
      try {
        newToken = await waitWithinSignal(
          tokenRefreshCoordinator.forceRefresh({
            expectedUserId: requestScope.userId,
            sessionGeneration: requestScope.sessionGeneration,
          }),
          requestSignal
        )
      } catch (error) {
        if (requestSignal.aborted) return { ok: false, status: 0, data: null }
        throw error
      }
      if (newToken) {
        if (requestScope.userId && jwtSubject(newToken) !== requestScope.userId) {
          return { ok: false, status: 0, data: null, stale: true }
        }
        if (scopeBound && !isViewerScopeCurrent(requestScope)) {
          return { ok: false, status: 0, data: null, stale: true }
        }
        if (requestSignal.aborted) return { ok: false, status: 0, data: null }
        headers['Authorization'] = `Bearer ${newToken}`
        let retryResponse: Response
        try {
          retryResponse = await waitWithinSignal(
            fetch(url, {
              method,
              headers,
              body: body ? JSON.stringify(body) : undefined,
              cache: 'no-store',
              signal: requestSignal,
            }),
            requestSignal
          )
        } catch (error) {
          if (
            requestSignal.aborted ||
            (error instanceof DOMException &&
              (error.name === 'AbortError' || error.name === 'TimeoutError'))
          ) {
            return { ok: false, status: 0, data: null }
          }
          throw error
        }
        let retryData: T | null = null
        try {
          if (requestSignal.aborted) return { ok: false, status: 0, data: null }
          retryData = await waitWithinSignal(retryResponse.json(), requestSignal)
        } catch {
          if (requestSignal.aborted) return { ok: false, status: 0, data: null }
          const ct = retryResponse.headers.get('content-type') || ''
          if (!ct.includes('application/json')) {
            logger.warn(
              `[api-client] Retry response is not JSON (status=${retryResponse.status}, content-type=${ct}), likely HTML error page`
            )
          }
        }
        if (scopeBound && !isViewerScopeCurrent(requestScope)) {
          return { ok: false, status: 0, data: null, stale: true }
        }
        if (requestSignal.aborted) return { ok: false, status: 0, data: null }
        return { ok: retryResponse.ok, status: retryResponse.status, data: retryData }
      }
    }

    let data: T | null = null
    try {
      if (requestSignal.aborted) return { ok: false, status: 0, data: null }
      data = await waitWithinSignal(response.json(), requestSignal)
    } catch {
      if (requestSignal.aborted) return { ok: false, status: 0, data: null }
      const ct = response.headers.get('content-type') || ''
      if (!ct.includes('application/json')) {
        logger.warn(
          `[api-client] Response is not JSON (status=${response.status}, content-type=${ct}), likely HTML error page`
        )
      }
    }
    if (scopeBound && !isViewerScopeCurrent(requestScope)) {
      return { ok: false, status: 0, data: null, stale: true }
    }
    if (requestSignal.aborted) return { ok: false, status: 0, data: null }
    return { ok: response.ok, status: response.status, data }
  } finally {
    boundedRequest.cleanup()
  }
}

/**
 * Map HTTP status codes to error code strings for consistent client-side handling.
 * Handles both proxy-level errors (which return { code, message } objects)
 * and route-handler errors (which return plain string messages).
 */
function httpStatusToErrorCode(status: number): string {
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'SERVER_ERROR'
  return 'REQUEST_FAILED'
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
