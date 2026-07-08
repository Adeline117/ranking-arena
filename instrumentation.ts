/**
 * Next.js Instrumentation
 * 用于初始化 Sentry 和其他监控工具
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')

    if (process.env.NODE_ENV !== 'production') {
      const { logLocalUxSessionStart } = await import('./lib/utils/local-ux-audit-log')
      logLocalUxSessionStart()
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

export const onRequestError = async (
  err: { digest: string } & Error,
  request: {
    path: string
    method: string
    headers: { [key: string]: string }
  },
  context: {
    routerKind: 'Pages Router' | 'App Router'
    routePath: string
    routeType: 'render' | 'route' | 'action' | 'middleware'
    renderSource: 'react-server-components' | 'react-server-components-payload' | 'server-rendering'
    revalidateReason: 'on-demand' | 'stale' | undefined
    renderType: 'dynamic' | 'dynamic-resume'
  }
) => {
  const msg = err.message || ''

  if (process.env.NODE_ENV !== 'production') {
    try {
      const { logLocalUxRequestError } = await import('./lib/utils/local-ux-audit-log')
      logLocalUxRequestError({
        path: request.path,
        method: request.method,
        message: msg,
        routePath: context.routePath,
        routeType: context.routeType,
      })
    } catch {
      /* local UX audit logging is best-effort only */
    }
  }

  // 不上报已知的非关键错误
  if (/ECONNRESET|ENOTFOUND|ETIMEDOUT|AbortError|JWTExpired|JWT expired/.test(msg)) {
    return
  }

  // 动态导入 Sentry 以避免边缘运行时问题
  const Sentry = await import('@sentry/nextjs')
  
  Sentry.captureException(err, {
    tags: {
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
      source: 'nextjs-instrumentation',
    },
    extra: {
      digest: err.digest,
      method: request.method,
      path: request.path,
      renderSource: context.renderSource,
      revalidateReason: context.revalidateReason,
    },
  })
}
