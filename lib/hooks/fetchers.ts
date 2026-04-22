'use client'

/**
 * Pure fetcher functions — shared by both SWR and React Query hooks.
 *
 * Extracted from useSWR.ts during Phase 1 of the SWR → React Query migration.
 * These functions have ZERO coupling to any data-fetching library.
 */

import { t } from '@/lib/i18n'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'

// ============================================
// 请求超时配置
// ============================================

const FETCH_TIMEOUT = 15000 // 15 秒超时

/**
 * 带超时的 fetch 请求
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout: number = FETCH_TIMEOUT
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    if (error instanceof Error && (error.name === 'AbortError' || error.message === 'The user aborted a request.')) {
      const timeoutError = new Error(t('errorTimeoutCheckNetwork'))
      timeoutError.name = 'TimeoutError'
      throw timeoutError
    }
    throw error
  }
}

// ============================================
// 通用 fetcher
// ============================================

export async function fetcher<T>(url: string): Promise<T> {
  const startTime = performance.now()
  try {
    const response = await fetchWithTimeout(url, {
      credentials: 'include',
    })

    if (!response.ok) {
      const error = new Error(t('errorRequestFailed')) as Error & { status: number; info: unknown; url: string; duration: number }
      error.status = response.status
      error.url = url
      error.duration = Math.round(performance.now() - startTime)
      try {
        error.info = await response.json()
      } catch (_err) {
        /* parse fallback: response body is not JSON */
        error.info = await response.text()
      }
      throw error
    }

    return response.json()
  } catch (error) {
    // Enrich error with request context (Sentry breadcrumb pattern)
    if (error instanceof Error) {
      const enriched = error as Error & { url?: string; duration?: number }
      if (!enriched.url) enriched.url = url
      if (!enriched.duration) enriched.duration = Math.round(performance.now() - startTime)

      if (error.name === 'TimeoutError' || error.message.includes('timeout') || error.message.includes('超时')) {
        throw new Error(t('errorTimeout'))
      }
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        throw new Error(t('errorNetworkFailed'))
      }
    }
    throw error
  }
}

export async function fetcherWithAuth<T>(url: string, token?: string): Promise<T> {
  const headers: HeadersInit = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  try {
    const response = await fetchWithTimeout(url, {
      credentials: 'include',
      headers,
    })

    // On 401 with a token, attempt refresh via coordinator and retry once
    if (response.status === 401 && token && typeof window !== 'undefined') {
      const newToken = await tokenRefreshCoordinator.forceRefresh()
      if (newToken) {
        const retryHeaders: HeadersInit = { 'Authorization': `Bearer ${newToken}` }
        const retryResponse = await fetchWithTimeout(url, {
          credentials: 'include',
          headers: retryHeaders,
        })
        if (!retryResponse.ok) {
          const error = new Error(t('errorRequestFailed')) as Error & { status: number }
          error.status = retryResponse.status
          throw error
        }
        return retryResponse.json()
      }
    }

    if (!response.ok) {
      const error = new Error(t('errorRequestFailed')) as Error & { status: number }
      error.status = response.status
      throw error
    }

    return response.json()
  } catch (error) {
    // 处理超时和网络错误
    if (error instanceof Error) {
      if (error.name === 'TimeoutError' || error.message.includes('timeout') || error.message.includes('超时')) {
        throw new Error(t('errorTimeout'))
      }
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        throw new Error(t('errorNetworkFailed'))
      }
    }
    throw error
  }
}
