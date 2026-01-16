/**
 * A/B 测试框架
 * 支持基于用户 ID 的分流和实验管理
 */

import { isFeatureEnabled, type FeatureFlagName } from '@/lib/feature-flags'

// ============================================
// 类型定义
// ============================================

export interface Variant {
  /** 变体 ID */
  id: string
  /** 变体名称 */
  name: string
  /** 权重（0-100） */
  weight: number
  /** 变体配置 */
  config?: Record<string, unknown>
}

export interface Experiment {
  /** 实验 ID */
  id: string
  /** 实验名称 */
  name: string
  /** 实验描述 */
  description?: string
  /** 变体列表 */
  variants: Variant[]
  /** 是否启用 */
  enabled: boolean
  /** 流量百分比（0-100） */
  trafficPercentage: number
  /** 目标用户过滤 */
  targeting?: {
    /** 用户 ID 白名单 */
    userIdWhitelist?: string[]
    /** 是否仅新用户 */
    newUsersOnly?: boolean
    /** 设备类型 */
    deviceTypes?: ('mobile' | 'desktop' | 'tablet')[]
  }
  /** 开始时间 */
  startDate?: string
  /** 结束时间 */
  endDate?: string
  /** 关联的功能开关 */
  featureFlag?: string
}

export interface ExperimentAssignment {
  /** 实验 ID */
  experimentId: string
  /** 分配的变体 ID */
  variantId: string
  /** 分配时间 */
  assignedAt: number
  /** 是否在实验组（非对照组） */
  isInExperiment: boolean
}

// ============================================
// 常量
// ============================================

const ASSIGNMENT_STORAGE_KEY = 'ab_assignments'

// ============================================
// 预定义实验
// ============================================

export const Experiments: Record<string, Experiment> = {
  /** 新首页布局实验 */
  NEW_HOMEPAGE_LAYOUT: {
    id: 'new_homepage_layout',
    name: '新首页布局',
    description: '测试新的首页排版和组件布局',
    enabled: false,
    trafficPercentage: 50,
    variants: [
      { id: 'control', name: '对照组', weight: 50 },
      { id: 'variant_a', name: '新布局 A', weight: 50 },
    ],
  },

  /** 交易员卡片样式实验 */
  TRADER_CARD_STYLE: {
    id: 'trader_card_style',
    name: '交易员卡片样式',
    description: '测试不同的交易员卡片展示样式',
    enabled: false,
    trafficPercentage: 30,
    variants: [
      { id: 'control', name: '当前样式', weight: 34 },
      { id: 'compact', name: '紧凑样式', weight: 33 },
      { id: 'detailed', name: '详细样式', weight: 33 },
    ],
  },

  /** 推荐算法实验 */
  RECOMMENDATION_ALGO: {
    id: 'recommendation_algo',
    name: '推荐算法',
    description: '测试新的内容推荐算法',
    enabled: false,
    trafficPercentage: 20,
    variants: [
      { id: 'control', name: '当前算法', weight: 50 },
      { id: 'ml_based', name: 'ML 推荐', weight: 50 },
    ],
    targeting: {
      newUsersOnly: false,
    },
  },

  /** 订阅页面实验 */
  SUBSCRIPTION_PAGE: {
    id: 'subscription_page',
    name: '订阅页面',
    description: '测试不同的订阅页面设计',
    enabled: false,
    trafficPercentage: 50,
    variants: [
      { id: 'control', name: '当前设计', weight: 50 },
      { id: 'social_proof', name: '社会认证版', weight: 50, config: { showTestimonials: true } },
    ],
  },
}

// ============================================
// A/B 测试管理器
// ============================================

class ABTestManager {
  private assignments: Map<string, ExperimentAssignment> = new Map()
  private userId: string | null = null

  constructor() {
    this.loadAssignments()
  }

  /**
   * 设置用户 ID
   */
  setUserId(userId: string | null): void {
    this.userId = userId
    // 用户变更时重新加载分配
    if (userId) {
      this.loadAssignments()
    }
  }

  /**
   * 获取用户 ID
   */
  getUserId(): string {
    if (this.userId) return this.userId

    // 生成匿名 ID
    if (typeof window !== 'undefined') {
      let anonymousId = localStorage.getItem('ab_anonymous_id')
      if (!anonymousId) {
        anonymousId = `anon_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
        localStorage.setItem('ab_anonymous_id', anonymousId)
      }
      return anonymousId
    }

    return 'server'
  }

  /**
   * 加载保存的分配
   */
  private loadAssignments(): void {
    if (typeof window === 'undefined') return

    try {
      const saved = localStorage.getItem(ASSIGNMENT_STORAGE_KEY)
      if (saved) {
        const data = JSON.parse(saved) as Record<string, ExperimentAssignment>
        for (const [id, assignment] of Object.entries(data)) {
          this.assignments.set(id, assignment)
        }
      }
    } catch (error) {
      console.error('[AB] 加载分配失败:', error)
    }
  }

  /**
   * 保存分配
   */
  private saveAssignments(): void {
    if (typeof window === 'undefined') return

    try {
      const data: Record<string, ExperimentAssignment> = {}
      for (const [id, assignment] of this.assignments.entries()) {
        data[id] = assignment
      }
      localStorage.setItem(ASSIGNMENT_STORAGE_KEY, JSON.stringify(data))
    } catch (error) {
      console.error('[AB] 保存分配失败:', error)
    }
  }

  /**
   * 获取实验变体
   */
  getVariant(experimentId: string): Variant | null {
    const experiment = Experiments[experimentId] || Object.values(Experiments).find((e) => e.id === experimentId)
    if (!experiment) {
      console.warn(`[AB] 未找到实验: ${experimentId}`)
      return null
    }

    // 检查是否启用
    if (!experiment.enabled) {
      return experiment.variants.find((v) => v.id === 'control') || experiment.variants[0]
    }

    // 检查功能开关
    if (experiment.featureFlag && !isFeatureEnabled(experiment.featureFlag as FeatureFlagName)) {
      return experiment.variants.find((v) => v.id === 'control') || experiment.variants[0]
    }

    // 检查时间范围
    const now = new Date()
    if (experiment.startDate && new Date(experiment.startDate) > now) {
      return experiment.variants.find((v) => v.id === 'control') || experiment.variants[0]
    }
    if (experiment.endDate && new Date(experiment.endDate) < now) {
      return experiment.variants.find((v) => v.id === 'control') || experiment.variants[0]
    }

    // 检查已有分配
    const existing = this.assignments.get(experimentId)
    if (existing) {
      const variant = experiment.variants.find((v) => v.id === existing.variantId)
      if (variant) return variant
    }

    // 新分配
    const assignment = this.assignVariant(experiment)
    return experiment.variants.find((v) => v.id === assignment.variantId) || experiment.variants[0]
  }

  /**
   * 分配变体
   */
  private assignVariant(experiment: Experiment): ExperimentAssignment {
    const userId = this.getUserId()

    // 检查是否在流量范围内
    const trafficHash = this.hashString(`${userId}:${experiment.id}:traffic`)
    const inTraffic = (trafficHash % 100) < experiment.trafficPercentage

    if (!inTraffic) {
      // 不在流量范围内，分配到对照组
      const controlVariant = experiment.variants.find((v) => v.id === 'control') || experiment.variants[0]
      const assignment: ExperimentAssignment = {
        experimentId: experiment.id,
        variantId: controlVariant.id,
        assignedAt: Date.now(),
        isInExperiment: false,
      }
      this.assignments.set(experiment.id, assignment)
      this.saveAssignments()
      return assignment
    }

    // 检查目标定向
    if (experiment.targeting) {
      // 白名单检查
      if (experiment.targeting.userIdWhitelist?.length && this.userId) {
        if (!experiment.targeting.userIdWhitelist.includes(this.userId)) {
          const controlVariant = experiment.variants.find((v) => v.id === 'control') || experiment.variants[0]
          const assignment: ExperimentAssignment = {
            experimentId: experiment.id,
            variantId: controlVariant.id,
            assignedAt: Date.now(),
            isInExperiment: false,
          }
          this.assignments.set(experiment.id, assignment)
          this.saveAssignments()
          return assignment
        }
      }
    }

    // 基于权重分配变体
    const variantHash = this.hashString(`${userId}:${experiment.id}:variant`)
    const variantRoll = variantHash % 100

    let cumulative = 0
    let selectedVariant = experiment.variants[0]

    for (const variant of experiment.variants) {
      cumulative += variant.weight
      if (variantRoll < cumulative) {
        selectedVariant = variant
        break
      }
    }

    const assignment: ExperimentAssignment = {
      experimentId: experiment.id,
      variantId: selectedVariant.id,
      assignedAt: Date.now(),
      isInExperiment: true,
    }

    this.assignments.set(experiment.id, assignment)
    this.saveAssignments()

    // 记录分配事件
    this.trackAssignment(experiment, selectedVariant)

    return assignment
  }

  /**
   * 哈希字符串
   */
  private hashString(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32bit integer
    }
    return Math.abs(hash)
  }

  /**
   * 追踪分配
   * 集成分析后端，发送实验分配事件
   */
  private trackAssignment(experiment: Experiment, variant: Variant): void {
    // 开发环境日志
    if (process.env.NODE_ENV === 'development') {
      console.log(`[AB] 分配: ${experiment.name} -> ${variant.name}`)
    }

    // 发送到分析系统（如果存在）
    if (typeof window !== 'undefined' && (window as any).gtag) {
      (window as any).gtag('event', 'experiment_assigned', {
        experiment_id: experiment.id,
        experiment_name: experiment.name,
        variant_id: variant.id,
        variant_name: variant.name,
      })
    }
  }

  /**
   * 追踪转化
   * 记录实验目标完成事件
   */
  trackConversion(experimentId: string, goalName: string, value?: number): void {
    const assignment = this.assignments.get(experimentId)
    if (!assignment) return

    // 开发环境日志
    if (process.env.NODE_ENV === 'development') {
      console.log(`[AB] 转化: ${experimentId} / ${goalName}`, { value })
    }

    // 发送到分析系统（如果存在）
    if (typeof window !== 'undefined' && (window as any).gtag) {
      (window as any).gtag('event', 'experiment_conversion', {
        experiment_id: experimentId,
        variant_id: assignment.variantId,
        goal_name: goalName,
        value,
      })
    }
  }

  /**
   * 获取所有分配
   */
  getAllAssignments(): Map<string, ExperimentAssignment> {
    return new Map(this.assignments)
  }

  /**
   * 清除所有分配（用于测试）
   */
  clearAssignments(): void {
    this.assignments.clear()
    if (typeof window !== 'undefined') {
      localStorage.removeItem(ASSIGNMENT_STORAGE_KEY)
    }
  }
}

// ============================================
// 全局实例
// ============================================

export const abTest = typeof window !== 'undefined' ? new ABTestManager() : null

// ============================================
// React Hooks
// ============================================

/**
 * 获取实验变体 Hook
 */
export function useExperiment(experimentId: string): {
  variant: Variant | null
  isLoading: boolean
  isInExperiment: boolean
} {
  // 服务端渲染时返回对照组
  if (typeof window === 'undefined') {
    const experiment = Experiments[experimentId]
    const control = experiment?.variants.find((v) => v.id === 'control') || experiment?.variants[0] || null
    return { variant: control, isLoading: false, isInExperiment: false }
  }

  const variant = abTest?.getVariant(experimentId) || null
  const assignment = abTest?.getAllAssignments().get(experimentId)

  return {
    variant,
    isLoading: false,
    isInExperiment: assignment?.isInExperiment || false,
  }
}

/**
 * 追踪实验转化
 */
export function trackExperimentConversion(
  experimentId: string,
  goalName: string,
  value?: number
): void {
  abTest?.trackConversion(experimentId, goalName, value)
}

// ============================================
// 导出
// ============================================

// Types are exported at definition
export { ABTestManager }
