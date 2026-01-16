/**
 * 漏斗分析工具
 * 追踪用户转化路径和关键步骤
 */

// ============================================
// 类型定义
// ============================================

export interface FunnelStep {
  /** 步骤 ID */
  id: string
  /** 步骤名称 */
  name: string
  /** 步骤描述 */
  description?: string
  /** 是否必须完成 */
  required?: boolean
}

export interface FunnelEvent {
  /** 漏斗 ID */
  funnelId: string
  /** 步骤 ID */
  stepId: string
  /** 用户 ID */
  userId?: string
  /** 会话 ID */
  sessionId: string
  /** 时间戳 */
  timestamp: number
  /** 附加数据 */
  metadata?: Record<string, unknown>
}

export interface FunnelDefinition {
  /** 漏斗 ID */
  id: string
  /** 漏斗名称 */
  name: string
  /** 漏斗描述 */
  description?: string
  /** 步骤列表 */
  steps: FunnelStep[]
  /** 超时时间（毫秒） */
  timeout?: number
}

export interface FunnelProgress {
  /** 漏斗 ID */
  funnelId: string
  /** 已完成的步骤 */
  completedSteps: string[]
  /** 当前步骤 */
  currentStep: string | null
  /** 开始时间 */
  startTime: number
  /** 是否已完成 */
  isCompleted: boolean
  /** 是否已放弃 */
  isAbandoned: boolean
}

// ============================================
// 常量
// ============================================

const FUNNEL_STORAGE_KEY = 'funnel_progress'
const SESSION_ID_KEY = 'funnel_session_id'

// ============================================
// 预定义漏斗
// ============================================

export const Funnels: Record<string, FunnelDefinition> = {
  /** 用户注册漏斗 */
  REGISTRATION: {
    id: 'registration',
    name: '用户注册',
    description: '从访问到完成注册的转化流程',
    steps: [
      { id: 'landing', name: '访问首页' },
      { id: 'click_login', name: '点击登录按钮' },
      { id: 'auth_start', name: '开始认证' },
      { id: 'auth_complete', name: '完成认证' },
      { id: 'profile_setup', name: '完善资料' },
    ],
    timeout: 30 * 60 * 1000, // 30 分钟
  },

  /** 交易所绑定漏斗 */
  EXCHANGE_BINDING: {
    id: 'exchange_binding',
    name: '交易所绑定',
    description: '用户绑定交易所账号的流程',
    steps: [
      { id: 'view_settings', name: '查看设置页面' },
      { id: 'click_bind', name: '点击绑定按钮' },
      { id: 'select_exchange', name: '选择交易所' },
      { id: 'enter_api_key', name: '输入 API Key' },
      { id: 'verify_complete', name: '验证完成' },
      { id: 'sync_data', name: '同步数据' },
    ],
    timeout: 15 * 60 * 1000, // 15 分钟
  },

  /** 发帖漏斗 */
  POST_CREATION: {
    id: 'post_creation',
    name: '发布帖子',
    description: '用户发布帖子的流程',
    steps: [
      { id: 'click_new_post', name: '点击发帖按钮' },
      { id: 'enter_title', name: '输入标题' },
      { id: 'enter_content', name: '输入内容' },
      { id: 'add_images', name: '添加图片', required: false },
      { id: 'preview', name: '预览', required: false },
      { id: 'publish', name: '发布' },
    ],
    timeout: 30 * 60 * 1000,
  },

  /** 订阅漏斗 */
  SUBSCRIPTION: {
    id: 'subscription',
    name: '订阅转化',
    description: '从免费用户到付费订阅的转化',
    steps: [
      { id: 'view_premium', name: '查看高级功能' },
      { id: 'click_upgrade', name: '点击升级按钮' },
      { id: 'select_plan', name: '选择套餐' },
      { id: 'enter_payment', name: '输入支付信息' },
      { id: 'confirm_payment', name: '确认支付' },
      { id: 'payment_success', name: '支付成功' },
    ],
    timeout: 10 * 60 * 1000,
  },
}

// ============================================
// 漏斗追踪器
// ============================================

class FunnelTracker {
  private sessionId: string
  private progressMap: Map<string, FunnelProgress> = new Map()
  private eventQueue: FunnelEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor() {
    this.sessionId = this.getOrCreateSessionId()
    this.loadProgress()
  }

  /**
   * 获取或创建会话 ID
   */
  private getOrCreateSessionId(): string {
    if (typeof window === 'undefined') return 'server'

    let sessionId = sessionStorage.getItem(SESSION_ID_KEY)
    if (!sessionId) {
      sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      sessionStorage.setItem(SESSION_ID_KEY, sessionId)
    }
    return sessionId
  }

  /**
   * 加载保存的进度
   */
  private loadProgress(): void {
    if (typeof window === 'undefined') return

    try {
      const saved = localStorage.getItem(FUNNEL_STORAGE_KEY)
      if (saved) {
        const data = JSON.parse(saved) as Record<string, FunnelProgress>
        const now = Date.now()

        // 恢复未超时的漏斗
        for (const [id, progress] of Object.entries(data)) {
          const funnel = Object.values(Funnels).find((f) => f.id === id)
          const timeout = funnel?.timeout || 30 * 60 * 1000

          if (!progress.isCompleted && !progress.isAbandoned && now - progress.startTime < timeout) {
            this.progressMap.set(id, progress)
          }
        }
      }
    } catch (error) {
      console.error('[Funnel] 加载进度失败:', error)
    }
  }

  /**
   * 保存进度
   */
  private saveProgress(): void {
    if (typeof window === 'undefined') return

    try {
      const data: Record<string, FunnelProgress> = {}
      for (const [id, progress] of this.progressMap.entries()) {
        data[id] = progress
      }
      localStorage.setItem(FUNNEL_STORAGE_KEY, JSON.stringify(data))
    } catch (error) {
      console.error('[Funnel] 保存进度失败:', error)
    }
  }

  /**
   * 开始漏斗
   */
  startFunnel(funnelId: string, userId?: string): void {
    const funnel = Object.values(Funnels).find((f) => f.id === funnelId)
    if (!funnel) {
      console.warn(`[Funnel] 未找到漏斗: ${funnelId}`)
      return
    }

    // 如果已经有进行中的漏斗，先标记为放弃
    const existing = this.progressMap.get(funnelId)
    if (existing && !existing.isCompleted && !existing.isAbandoned) {
      this.abandonFunnel(funnelId)
    }

    const progress: FunnelProgress = {
      funnelId,
      completedSteps: [],
      currentStep: funnel.steps[0]?.id || null,
      startTime: Date.now(),
      isCompleted: false,
      isAbandoned: false,
    }

    this.progressMap.set(funnelId, progress)
    this.saveProgress()

    // 记录开始事件
    this.trackStep(funnelId, funnel.steps[0]?.id || 'start', userId)
  }

  /**
   * 追踪步骤完成
   */
  trackStep(
    funnelId: string,
    stepId: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): void {
    const progress = this.progressMap.get(funnelId)
    if (!progress || progress.isCompleted || progress.isAbandoned) {
      return
    }

    const funnel = Object.values(Funnels).find((f) => f.id === funnelId)
    if (!funnel) return

    // 检查步骤是否存在
    const stepIndex = funnel.steps.findIndex((s) => s.id === stepId)
    if (stepIndex === -1) {
      console.warn(`[Funnel] 未找到步骤: ${stepId}`)
      return
    }

    // 记录事件
    const event: FunnelEvent = {
      funnelId,
      stepId,
      userId,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      metadata,
    }
    this.queueEvent(event)

    // 更新进度
    if (!progress.completedSteps.includes(stepId)) {
      progress.completedSteps.push(stepId)
    }
    progress.currentStep = stepId

    // 检查是否完成
    const requiredSteps = funnel.steps.filter((s) => s.required !== false)
    const allRequiredCompleted = requiredSteps.every((s) =>
      progress.completedSteps.includes(s.id)
    )

    if (allRequiredCompleted && stepIndex === funnel.steps.length - 1) {
      progress.isCompleted = true
      console.log(`[Funnel] 漏斗完成: ${funnelId}`)
    }

    this.saveProgress()
  }

  /**
   * 放弃漏斗
   */
  abandonFunnel(funnelId: string): void {
    const progress = this.progressMap.get(funnelId)
    if (!progress || progress.isCompleted) return

    progress.isAbandoned = true
    this.saveProgress()

    console.log(`[Funnel] 漏斗放弃: ${funnelId}, 完成步骤: ${progress.completedSteps.join(', ')}`)
  }

  /**
   * 获取漏斗进度
   */
  getProgress(funnelId: string): FunnelProgress | null {
    return this.progressMap.get(funnelId) || null
  }

  /**
   * 获取转化率
   */
  getConversionRate(funnelId: string): number {
    const progress = this.progressMap.get(funnelId)
    if (!progress) return 0

    const funnel = Object.values(Funnels).find((f) => f.id === funnelId)
    if (!funnel) return 0

    return (progress.completedSteps.length / funnel.steps.length) * 100
  }

  /**
   * 事件队列
   */
  private queueEvent(event: FunnelEvent): void {
    this.eventQueue.push(event)

    // 批量发送
    if (this.eventQueue.length >= 10) {
      this.flushEvents()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushEvents(), 5000)
    }
  }

  /**
   * 发送事件
   */
  private async flushEvents(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (this.eventQueue.length === 0) return

    const events = [...this.eventQueue]
    this.eventQueue = []

    try {
      // 发送到分析系统（如果存在）
      if (typeof window !== 'undefined' && (window as any).gtag) {
        events.forEach(event => {
          (window as any).gtag('event', 'funnel_step', {
            funnel_id: event.funnelId,
            step_id: event.stepId,
            timestamp: event.timestamp,
          })
        })
      }
      
      // 开发环境日志
      if (process.env.NODE_ENV === 'development') {
        console.log('[Funnel] 发送事件:', events.length, '条')
      }
    } catch (error) {
      // 失败时放回队列
      this.eventQueue = [...events, ...this.eventQueue]
    }
  }

  /**
   * 重置
   */
  reset(): void {
    this.progressMap.clear()
    this.eventQueue = []
    if (typeof window !== 'undefined') {
      localStorage.removeItem(FUNNEL_STORAGE_KEY)
    }
  }
}

// ============================================
// 全局实例
// ============================================

export const funnelTracker = typeof window !== 'undefined' ? new FunnelTracker() : null

// ============================================
// 便捷函数
// ============================================

/**
 * 开始注册漏斗
 */
export function startRegistrationFunnel(userId?: string): void {
  funnelTracker?.startFunnel('registration', userId)
}

/**
 * 开始交易所绑定漏斗
 */
export function startExchangeBindingFunnel(userId?: string): void {
  funnelTracker?.startFunnel('exchange_binding', userId)
}

/**
 * 开始发帖漏斗
 */
export function startPostCreationFunnel(userId?: string): void {
  funnelTracker?.startFunnel('post_creation', userId)
}

/**
 * 开始订阅漏斗
 */
export function startSubscriptionFunnel(userId?: string): void {
  funnelTracker?.startFunnel('subscription', userId)
}

/**
 * 追踪漏斗步骤
 */
export function trackFunnelStep(
  funnelId: string,
  stepId: string,
  userId?: string,
  metadata?: Record<string, unknown>
): void {
  funnelTracker?.trackStep(funnelId, stepId, userId, metadata)
}

// ============================================
// 导出
// ============================================

// Types are exported at definition
export { FunnelTracker }
