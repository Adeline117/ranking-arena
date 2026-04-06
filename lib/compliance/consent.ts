import { logger } from '@/lib/logger'

/** Extend Window to include GA disable flags */
declare global {
  interface Window {
    [gaDisableKey: `ga-disable-${string}`]: boolean | undefined
  }
}

/**
 * 用户同意状态管理
 * 管理 Cookie 和数据处理同意
 */

// ============================================
// 类型定义
// ============================================

/**
 * 同意类别
 */
export type ConsentCategory = 'necessary' | 'analytics' | 'marketing' | 'preferences'

/**
 * 同意状态
 */
export interface ConsentState {
  necessary: boolean      // 必要 Cookie（始终为 true）
  analytics: boolean      // 分析 Cookie
  marketing: boolean      // 营销 Cookie
  preferences: boolean    // 偏好设置 Cookie
  timestamp: number       // 同意时间戳
  version: string         // 同意政策版本
}

/**
 * 同意配置
 */
export interface ConsentConfig {
  /** 当前同意政策版本 */
  version: string
  /** 存储键名 */
  storageKey: string
  /** 过期天数 */
  expirationDays: number
}

// ============================================
// 配置
// ============================================

const DEFAULT_CONFIG: ConsentConfig = {
  version: '1.0',
  storageKey: 'arena_consent',
  expirationDays: 365,
}

// ============================================
// 默认同意状态
// ============================================

const DEFAULT_CONSENT: ConsentState = {
  necessary: true,    // 必要 Cookie 始终启用
  analytics: false,
  marketing: false,
  preferences: false,
  timestamp: 0,
  version: DEFAULT_CONFIG.version,
}

// ============================================
// 同意管理类
// ============================================

class ConsentManager {
  private config: ConsentConfig
  private state: ConsentState
  private listeners: Set<(state: ConsentState) => void>

  constructor(config: Partial<ConsentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.listeners = new Set()
    this.state = this.loadState()
  }

  /**
   * 从存储加载状态
   */
  private loadState(): ConsentState {
    if (typeof window === 'undefined') {
      return { ...DEFAULT_CONSENT }
    }

    try {
      const stored = localStorage.getItem(this.config.storageKey)
      if (!stored) {
        return { ...DEFAULT_CONSENT }
      }

      const parsed = JSON.parse(stored) as ConsentState

      // 检查版本是否匹配
      if (parsed.version !== this.config.version) {
        // 版本不匹配，需要重新获取同意
        return { ...DEFAULT_CONSENT }
      }

      // 检查是否过期
      const expirationMs = this.config.expirationDays * 24 * 60 * 60 * 1000
      if (Date.now() - parsed.timestamp > expirationMs) {
        return { ...DEFAULT_CONSENT }
      }

      return {
        ...DEFAULT_CONSENT,
        ...parsed,
        necessary: true, // 始终确保必要 Cookie 启用
      }
    } catch (_err) {
      // Intentionally swallowed: corrupted consent JSON in localStorage, reset to defaults
      return { ...DEFAULT_CONSENT }
    }
  }

  /**
   * 保存状态到存储
   */
  private saveState(): void {
    if (typeof window === 'undefined') return

    try {
      localStorage.setItem(this.config.storageKey, JSON.stringify(this.state))
    } catch (error) {
      logger.error('[Consent] Failed to save state:', error)
    }
  }

  /**
   * 通知监听器
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.state))
  }

  /**
   * 获取当前同意状态
   */
  getState(): ConsentState {
    return { ...this.state }
  }

  /**
   * 检查是否已获得同意
   */
  hasConsented(): boolean {
    return this.state.timestamp > 0
  }

  /**
   * 检查特定类别是否已同意
   */
  hasConsentFor(category: ConsentCategory): boolean {
    return this.state[category] === true
  }

  /**
   * 设置同意状态
   */
  setConsent(categories: Partial<Omit<ConsentState, 'necessary' | 'timestamp' | 'version'>>): void {
    this.state = {
      ...this.state,
      ...categories,
      necessary: true, // 必要 Cookie 始终启用
      timestamp: Date.now(),
      version: this.config.version,
    }

    this.saveState()
    this.notifyListeners()

    // 根据同意状态启用/禁用追踪
    this.applyConsent()
  }

  /**
   * 接受所有 Cookie
   */
  acceptAll(): void {
    this.setConsent({
      analytics: true,
      marketing: true,
      preferences: true,
    })
  }

  /**
   * 仅接受必要 Cookie
   */
  acceptNecessaryOnly(): void {
    this.setConsent({
      analytics: false,
      marketing: false,
      preferences: false,
    })
  }

  /**
   * 撤销同意
   */
  revokeConsent(): void {
    this.state = { ...DEFAULT_CONSENT }
    
    if (typeof window !== 'undefined') {
      localStorage.removeItem(this.config.storageKey)
    }

    this.notifyListeners()
    this.applyConsent()
  }

  /**
   * 根据同意状态应用设置
   */
  private applyConsent(): void {
    if (typeof window === 'undefined') return

    // 分析追踪
    if (!this.state.analytics) {
      // 禁用 Google Analytics
      window['ga-disable-GA_MEASUREMENT_ID'] = true
      
      // 通知 analytics 模块
      try {
        const event = new CustomEvent('consent:analytics', { 
          detail: { enabled: false } 
        })
        window.dispatchEvent(event)
      } catch (_err) { /* Intentionally swallowed: CustomEvent dispatch may fail in restricted environments */ }
    } else {
      // 启用分析
      delete window['ga-disable-GA_MEASUREMENT_ID']

      try {
        const event = new CustomEvent('consent:analytics', {
          detail: { enabled: true }
        })
        window.dispatchEvent(event)
      } catch (_err) { /* Intentionally swallowed: CustomEvent dispatch may fail in restricted environments */ }
    }
  }

  /**
   * 订阅状态变化
   */
  subscribe(listener: (state: ConsentState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 更新配置
   */
  configure(config: Partial<ConsentConfig>): void {
    this.config = { ...this.config, ...config }
  }
}

// ============================================
// 单例
// ============================================

let consentManagerInstance: ConsentManager | null = null

export function getConsentManager(config?: Partial<ConsentConfig>): ConsentManager {
  if (!consentManagerInstance) {
    consentManagerInstance = new ConsentManager(config)
  } else if (config) {
    consentManagerInstance.configure(config)
  }
  return consentManagerInstance
}

// ============================================
// 快捷函数
// ============================================

export function getConsentState(): ConsentState {
  return getConsentManager().getState()
}

export function hasConsented(): boolean {
  return getConsentManager().hasConsented()
}

export function hasConsentFor(category: ConsentCategory): boolean {
  return getConsentManager().hasConsentFor(category)
}

export function setConsent(categories: Partial<Omit<ConsentState, 'necessary' | 'timestamp' | 'version'>>): void {
  getConsentManager().setConsent(categories)
}

export function acceptAllConsent(): void {
  getConsentManager().acceptAll()
}

export function acceptNecessaryOnlyConsent(): void {
  getConsentManager().acceptNecessaryOnly()
}

export function revokeConsent(): void {
  getConsentManager().revokeConsent()
}

export function subscribeToConsent(listener: (state: ConsentState) => void): () => void {
  return getConsentManager().subscribe(listener)
}

// 导出类
export { ConsentManager }
