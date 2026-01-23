/**
 * Sentry 客户端配置
 * 用于捕获浏览器端错误和性能监控
 */

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: SENTRY_DSN,
  
  // 启用性能监控 - 生产环境采样 20%，开发环境 100%
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  
  // 启用 Session Replay
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  
  // 启用性能分析
  profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,
  
  // 环境标识
  environment: process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || 'development',
  
  // 禁用调试模式（避免潜在的渲染问题）
  debug: false,
  
  // 过滤已知的非关键错误
  ignoreErrors: [
    // 浏览器扩展错误
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    // 网络错误
    'Network request failed',
    'Failed to fetch',
    'Load failed',
    // 用户取消操作
    'AbortError',
    // ResizeObserver 错误（通常无害）
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications',
    // Hydration 错误（通常由浏览器扩展引起）
    'Hydration failed',
    'Text content does not match',
  ],
  
  // 过滤不重要的事务
  tracesSampler: (samplingContext) => {
    const name = samplingContext.name
    
    // 静态资源请求不采样
    if (name?.includes('/_next/static') || name?.includes('/favicon')) {
      return 0
    }
    
    // API 请求提高采样率
    if (name?.includes('/api/')) {
      return process.env.NODE_ENV === 'production' ? 0.3 : 1.0
    }
    
    // 关键用户操作页面
    if (name?.includes('/trader/') || name?.includes('/post/')) {
      return process.env.NODE_ENV === 'production' ? 0.25 : 1.0
    }
    
    // 默认采样率
    return process.env.NODE_ENV === 'production' ? 0.2 : 1.0
  },
  
  // 在发送前处理事件
  beforeSend(event, _hint) {
    // 过滤开发环境的错误
    if (process.env.NODE_ENV === 'development') {
      console.log('[Sentry] Would send event:', event)
    }
    
    // 脱敏处理
    if (event.user) {
      delete event.user.ip_address
    }
    
    // 添加自定义上下文
    if (typeof window !== 'undefined') {
      event.contexts = {
        ...event.contexts,
        browser: {
          ...event.contexts?.browser,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
        },
      }
    }
    
    return event
  },
  
  // 在发送事务前处理
  beforeSendTransaction(transaction) {
    // 过滤掉过短的事务（可能是取消的请求）
    const duration = transaction.timestamp && transaction.start_timestamp
      ? (transaction.timestamp - transaction.start_timestamp) * 1000
      : 0
    
    if (duration < 10) {
      return null
    }
    
    return transaction
  },
  
  // 设置标签
  initialScope: {
    tags: {
      app: 'ranking-arena',
      platform: 'web',
    },
  },
  
  // 集成配置
  integrations: [
    Sentry.replayIntegration({
      // 隐藏敏感信息
      maskAllText: false,
      maskAllInputs: true,
      blockAllMedia: false,
    }),
    Sentry.browserTracingIntegration({
      // 追踪页面加载
      enableLongTask: true,
      enableInp: true,
    }),
    Sentry.feedbackIntegration({
      // 用户反馈配置
      colorScheme: 'dark',
      buttonLabel: '反馈问题',
      submitButtonLabel: '提交',
      cancelButtonLabel: '取消',
      formTitle: '反馈问题',
      messagePlaceholder: '请描述您遇到的问题...',
      successMessageText: '感谢您的反馈！',
      showBranding: false,
      autoInject: false, // 手动控制显示
    }),
  ],
})

// 导出 Sentry 用于自定义追踪
export { Sentry }
