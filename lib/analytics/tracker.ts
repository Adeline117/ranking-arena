/**
 * 埋点核心模块
 * 提供事件追踪、批量上报、本地存储等功能
 */

import type { TrackEvent, EventName, EventProps } from './events'

// 配置
interface TrackerConfig {
  enabled: boolean
  batchSize: number
  flushInterval: number // 毫秒
  maxQueueSize: number
  debug: boolean
  endpoint?: string
  userId?: string
  sessionId?: string
}

// 队列中的事件
interface QueuedEvent {
  event: TrackEvent
  timestamp: number
  sessionId: string
  userId?: string
  url: string
  userAgent: string
}

// 默认配置
const DEFAULT_CONFIG: TrackerConfig = {
  enabled: true,
  batchSize: 10,
  flushInterval: 30000, // 30秒
  maxQueueSize: 100,
  debug: process.env.NODE_ENV === 'development',
}

class Tracker {
  private config: TrackerConfig
  private queue: QueuedEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private sessionId: string

  constructor(config: Partial<TrackerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.sessionId = this.generateSessionId()
    
    if (typeof window !== 'undefined') {
      this.init()
    }
  }

  private init() {
    // 启动定时上报
    if (this.config.flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        this.flush()
      }, this.config.flushInterval)
    }

    // 页面卸载时上报
    window.addEventListener('beforeunload', () => {
      this.flush(true)
    })

    // 页面可见性变化时上报
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flush(true)
      }
    })
  }

  private generateSessionId(): string {
    if (typeof window !== 'undefined') {
      // 尝试从 sessionStorage 获取
      const existing = sessionStorage.getItem('analytics_session_id')
      if (existing) return existing
      
      // 生成新的 session ID
      const newId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
      sessionStorage.setItem('analytics_session_id', newId)
      return newId
    }
    return `server-${Date.now()}`
  }

  /**
   * 追踪事件
   */
  track<T extends EventName>(name: T, props: EventProps<T>) {
    if (!this.config.enabled) return

    const event: TrackEvent = { name, props } as TrackEvent

    const queuedEvent: QueuedEvent = {
      event,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      userId: this.config.userId,
      url: typeof window !== 'undefined' ? window.location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    }

    if (this.config.debug) {
      console.log('[Analytics]', name, props)
    }

    this.queue.push(queuedEvent)

    // 检查是否需要立即上报
    if (this.queue.length >= this.config.batchSize) {
      this.flush()
    }

    // 检查队列大小
    if (this.queue.length > this.config.maxQueueSize) {
      this.queue = this.queue.slice(-this.config.maxQueueSize)
    }
  }

  /**
   * 页面浏览追踪
   */
  pageView(page: string, additionalProps: Partial<EventProps<'page_view'>> = {}) {
    this.track('page_view', {
      page,
      path: typeof window !== 'undefined' ? window.location.pathname : '',
      referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      title: typeof document !== 'undefined' ? document.title : undefined,
      ...additionalProps,
    })
  }

  /**
   * 设置用户 ID
   */
  setUserId(userId: string | undefined) {
    this.config.userId = userId
  }

  /**
   * 上报队列中的事件
   */
  async flush(sync = false) {
    if (this.queue.length === 0) return

    const eventsToSend = [...this.queue]
    this.queue = []

    try {
      if (this.config.endpoint) {
        if (sync && typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
          // 同步模式使用 sendBeacon
          navigator.sendBeacon(
            this.config.endpoint,
            JSON.stringify({ events: eventsToSend })
          )
        } else {
          // 异步模式使用 fetch
          await fetch(this.config.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: eventsToSend }),
            keepalive: true,
          })
        }
      } else {
        // 没有配置 endpoint，存储到 localStorage
        this.storeLocally(eventsToSend)
      }
    } catch (error) {
      if (this.config.debug) {
        console.error('[Analytics] Flush failed:', error)
      }
      // 失败时将事件放回队列
      this.queue = [...eventsToSend, ...this.queue].slice(-this.config.maxQueueSize)
    }
  }

  /**
   * 本地存储事件（用于离线或无后端场景）
   */
  private storeLocally(events: QueuedEvent[]) {
    if (typeof window === 'undefined') return

    try {
      const key = 'analytics_events'
      const existing = JSON.parse(localStorage.getItem(key) || '[]')
      const merged = [...existing, ...events].slice(-500) // 最多保留 500 条
      localStorage.setItem(key, JSON.stringify(merged))
    } catch {
      // localStorage 可能满了
    }
  }

  /**
   * 获取本地存储的事件
   */
  getLocalEvents(): QueuedEvent[] {
    if (typeof window === 'undefined') return []

    try {
      return JSON.parse(localStorage.getItem('analytics_events') || '[]')
    } catch {
      return []
    }
  }

  /**
   * 清除本地存储的事件
   */
  clearLocalEvents() {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('analytics_events')
    }
  }

  /**
   * 更新配置
   */
  configure(config: Partial<TrackerConfig>) {
    this.config = { ...this.config, ...config }
  }

  /**
   * 销毁 tracker
   */
  destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flush(true)
  }
}

// 全局单例
let trackerInstance: Tracker | null = null

export function getTracker(config?: Partial<TrackerConfig>): Tracker {
  if (!trackerInstance) {
    trackerInstance = new Tracker(config)
  } else if (config) {
    trackerInstance.configure(config)
  }
  return trackerInstance
}

export function track<T extends EventName>(name: T, props: EventProps<T>) {
  getTracker().track(name, props)
}

export function pageView(page: string, additionalProps?: Partial<EventProps<'page_view'>>) {
  getTracker().pageView(page, additionalProps)
}

export function setUserId(userId: string | undefined) {
  getTracker().setUserId(userId)
}

export { Tracker }
