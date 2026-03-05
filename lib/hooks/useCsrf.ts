/**
 * CSRF Token Hook
 * 用于客户端获取和管理 CSRF Token
 */

'use client'

import { useCallback, useEffect, useState } from 'react'
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'

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
 * CSRF Token Hook
 * 返回当前 CSRF Token 和获取 headers 的方法
 */
export function useCsrf() {
  const [token, setToken] = useState<string | null>(null)
  
  // 初始化或刷新 Token
  useEffect(() => {
    let csrfToken = getCsrfTokenFromCookie()
    
    if (!csrfToken) {
      // 生成新 token
      csrfToken = generateClientCsrfToken()
      setCsrfTokenCookie(csrfToken)
    }
    
    setToken(csrfToken)
  }, [])
  
  // 刷新 Token
  const refreshToken = useCallback(() => {
    const newToken = generateClientCsrfToken()
    setCsrfTokenCookie(newToken)
    setToken(newToken)
    return newToken
  }, [])
  
  // 获取包含 CSRF Token 的 headers
  const getCsrfHeaders = useCallback((): Record<string, string> => {
    const currentToken = token || getCsrfTokenFromCookie()
    if (!currentToken) {
      return {}
    }
    return {
      [CSRF_HEADER_NAME]: currentToken,
    }
  }, [token])
  
  // 创建包含 CSRF Token 的 fetch 配置
  const csrfFetch = useCallback(
    async (url: string, options: RequestInit = {}): Promise<Response> => {
      const currentToken = token || getCsrfTokenFromCookie()
      
      const headers = new Headers(options.headers)
      if (currentToken) {
        headers.set(CSRF_HEADER_NAME, currentToken)
      }
      
      return fetch(url, {
        ...options,
        headers,
        credentials: 'include', // 确保发送 cookies
      })
    },
    [token]
  )
  
  return {
    token,
    refreshToken,
    getCsrfHeaders,
    csrfFetch,
    headerName: CSRF_HEADER_NAME,
  }
}

/**
 * 获取 CSRF Token（非 Hook 版本，用于一次性调用）
 */
export function getCsrfToken(): string | null {
  let token = getCsrfTokenFromCookie()
  
  if (!token && typeof document !== 'undefined') {
    token = generateClientCsrfToken()
    setCsrfTokenCookie(token)
  }
  
  return token
}

/**
 * 创建带 CSRF Token 的 Headers
 */
export function createCsrfHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
  const token = getCsrfToken()
  
  return {
    ...additionalHeaders,
    ...(token ? { [CSRF_HEADER_NAME]: token } : {}),
  }
}
