/**
 * 客户端用户活动追踪器
 * 批量收集事件, 每30秒或页面卸载时发送
 */

type ActivityAction =
  | 'page_view'
  | 'search'
  | 'follow'
  | 'unfollow'
  | 'like'
  | 'post'
  | 'compare'
  | 'library_view'
  | 'trade_copy'

interface ActivityEvent {
  action: ActivityAction
  metadata?: Record<string, unknown>
  created_at: string
}

const BATCH_INTERVAL = 30_000
const MAX_BATCH_SIZE = 100

const eventQueue: ActivityEvent[] = []
let _flushTimer: ReturnType<typeof setInterval> | null = null
let initialized = false

function enqueue(action: ActivityAction, metadata?: Record<string, unknown>) {
  eventQueue.push({
    action,
    metadata,
    created_at: new Date().toISOString(),
  })

  if (eventQueue.length >= MAX_BATCH_SIZE) {
    flush()
  }
}

async function flush() {
  if (eventQueue.length === 0) return

  const batch = eventQueue.splice(0, MAX_BATCH_SIZE)

  try {
    const token =
      typeof window !== 'undefined'
        ? localStorage.getItem('arena-auth')
        : null

    // 从 supabase session 中提取 access_token
    let accessToken = ''
    if (token) {
      try {
        const parsed = JSON.parse(token)
        accessToken = parsed?.access_token || parsed?.currentSession?.access_token || ''
      } catch {
        // ignore
      }
    }

    const res = await fetch('/api/activity', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    })

    if (!res.ok) {
      // 发送失败, 放回队列
      eventQueue.unshift(...batch)
    }
  } catch {
    eventQueue.unshift(...batch)
  }
}

function ensureInitialized() {
  if (initialized || typeof window === 'undefined') return
  initialized = true

  _flushTimer = setInterval(flush, BATCH_INTERVAL)

  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush()
    }
  })

  window.addEventListener('beforeunload', () => {
    flush()
  })
}

// -- 公开 API --

export function trackPageView(path: string) {
  ensureInitialized()
  enqueue('page_view', { path })
}

export function trackSearch(query: string, resultCount?: number) {
  ensureInitialized()
  enqueue('search', { query, resultCount })
}

export function trackFollow(targetUserId: string) {
  ensureInitialized()
  enqueue('follow', { targetUserId })
}

export function trackUnfollow(targetUserId: string) {
  ensureInitialized()
  enqueue('unfollow', { targetUserId })
}

export function trackLike(postId: string) {
  ensureInitialized()
  enqueue('like', { postId })
}

export function trackPost(postId: string) {
  ensureInitialized()
  enqueue('post', { postId })
}

export function trackCompare(items: string[]) {
  ensureInitialized()
  enqueue('compare', { items })
}

export function trackLibraryView(libraryId?: string) {
  ensureInitialized()
  enqueue('library_view', { libraryId })
}

export function trackTradeCopy(traderId: string) {
  ensureInitialized()
  enqueue('trade_copy', { traderId })
}

export function flushActivityEvents() {
  return flush()
}
