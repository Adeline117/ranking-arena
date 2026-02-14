/**
 * 全局错误拦截器
 * 拦截并处理应用中的各种错误，提供统一的错误处理逻辑
 */

import { getErrorMessage, reportError } from '@/lib/utils/error-handling'

// 全局 Toast 函数引用
let globalToast: ((message: string, type?: 'success' | 'error' | 'warning' | 'info') => void) | null = null

/**
 * 设置全局 Toast 函数
 */
export function setGlobalErrorHandler(toastFn: typeof globalToast) {
  globalToast = toastFn
}

/**
 * 拦截 fetch 请求错误
 */
export function interceptFetch() {
  // 保存原始 fetch
  const originalFetch = window.fetch
  
  window.fetch = async (...args) => {
    try {
      const response = await originalFetch(...args)
      
      // 如果响应不成功，创建错误对象
      if (!response.ok) {
        const errorData = await response.text().catch(() => response.statusText)
        const error = new Error(getErrorMessage({
          status: response.status,
          message: errorData
        }))
        ;(error as Error & { status?: number; response?: Response }).status = response.status
        ;(error as Error & { status?: number; response?: Response }).response = response
        
        // 只上报 5xx 服务器错误，跳过 4xx 用户错误
        if (response.status >= 500) {
          reportError(error, {
            source: 'fetch',
            url: typeof args[0] === 'string' ? args[0] : String(args[0]),
            status: response.status
          })
        }
        
        // 显示友好错误提示（跳过 401 — 静默处理认证过期）
        if (globalToast && response.status !== 401) {
          globalToast(getErrorMessage(error), 'error')
        }
        
        throw error
      }
      
      return response
    } catch (error) {
      // 网络错误或其他错误 — 不上报 Sentry（用户网络问题）
      const friendlyMessage = getErrorMessage(error)
      
      // 显示友好错误提示（仅对网络错误显示，避免重复）
      if (globalToast && error instanceof TypeError) {
        globalToast(friendlyMessage, 'error')
      }
      
      throw error
    }
  }
}

/**
 * 拦截未处理的 Promise 错误
 */
export function interceptUnhandledPromises() {
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason
    const friendlyMessage = getErrorMessage(error)
    
    // 上报错误
    reportError(error, {
      source: 'unhandledPromise',
      type: 'unhandledrejection'
    })
    
    // 显示友好错误提示
    if (globalToast) {
      globalToast(friendlyMessage, 'error')
    }
    
    // 阻止默认的控制台错误输出
    event.preventDefault()
    
    // 但在开发环境中仍然记录到控制台
    if (process.env.NODE_ENV === 'development') {
      console.error('Unhandled promise rejection:', error)
    }
  })
}

/**
 * 拦截运行时错误
 */
export function interceptGlobalErrors() {
  window.addEventListener('error', (event) => {
    const error = event.error || new Error(event.message)
    const friendlyMessage = getErrorMessage(error)
    
    // 上报错误
    reportError(error, {
      source: 'globalError',
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    })
    
    // 显示友好错误提示（仅对严重错误）
    if (globalToast && !error.message?.includes('Script error')) {
      globalToast(friendlyMessage, 'error')
    }
    
    // 在开发环境中记录到控制台
    if (process.env.NODE_ENV === 'development') {
      console.error('Global error:', error)
    }
  })
}

/**
 * 拦截 axios 错误（如果使用了 axios）
 */
export function interceptAxios() {
  // 动态导入 axios（如果可用）
  if (typeof window !== 'undefined') {
    import('axios').then((axios) => {
      // 添加响应拦截器
      axios.default.interceptors.response.use(
        (response) => response,
        (error) => {
          const friendlyMessage = getErrorMessage(error)
          
          // 上报错误
          reportError(error, {
            source: 'axios',
            url: error.config?.url,
            method: error.config?.method
          })
          
          // 显示友好错误提示
          if (globalToast) {
            globalToast(friendlyMessage, 'error')
          }
          
          return Promise.reject(error)
        }
      )
    }).catch(() => {
      // axios 不可用，跳过
    })
  }
}

/**
 * 初始化所有错误拦截器
 */
export function initializeErrorInterceptors(toastFn?: typeof globalToast) {
  if (toastFn) {
    setGlobalErrorHandler(toastFn)
  }
  
  // 仅在浏览器环境中初始化
  if (typeof window !== 'undefined') {
    interceptFetch()
    interceptUnhandledPromises()
    interceptGlobalErrors()
    interceptAxios()
    
    // Error interceptors initialized
  }
}

/**
 * 清理错误拦截器（如果需要的话）
 */
export function cleanupErrorInterceptors() {
  // 注意：实际上很难完全清理这些拦截器，
  // 因为我们修改了全局对象。这个函数主要用于测试环境。
  globalToast = null
}

const errorInterceptor = {
  setGlobalErrorHandler,
  interceptFetch,
  interceptUnhandledPromises, 
  interceptGlobalErrors,
  interceptAxios,
  initializeErrorInterceptors,
  cleanupErrorInterceptors
}
export default errorInterceptor