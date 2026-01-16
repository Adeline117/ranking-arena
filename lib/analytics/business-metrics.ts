/**
 * 业务指标追踪
 * 用于追踪核心业务事件和 KPI
 */

import { track } from './tracker'

// ============================================
// 类型定义
// ============================================

export interface TraderViewMetrics {
  traderId: string
  traderHandle: string
  source?: string
  referrer?: string
  viewDuration?: number
}

export interface PostEngagementMetrics {
  postId: string
  action: 'view' | 'like' | 'dislike' | 'comment' | 'share' | 'bookmark' | 'vote'
  authorHandle?: string
  groupId?: string
}

export interface SearchMetrics {
  query: string
  resultCount: number
  searchType: 'trader' | 'post' | 'group' | 'all'
  clickedResult?: string
  duration?: number
}

export interface ConversionMetrics {
  event: string
  value?: number
  currency?: string
  source?: string
  metadata?: Record<string, unknown>
}

export interface UserJourneyMetrics {
  step: string
  funnel: string
  success?: boolean
  metadata?: Record<string, unknown>
}

export interface PerformanceMetrics {
  name: string
  duration: number
  metadata?: Record<string, unknown>
}

// ============================================
// 业务指标追踪函数
// ============================================

/**
 * 追踪交易员页面浏览
 */
export function trackTraderView(metrics: TraderViewMetrics) {
  track('trader_view', {
    trader_id: metrics.traderId,
    trader_handle: metrics.traderHandle,
    source: metrics.source,
    referrer: metrics.referrer,
  })
}

/**
 * 追踪交易员页面停留时间
 */
export function trackTraderViewDuration(traderId: string, duration: number) {
  track('trader_view', {
    trader_id: traderId,
    trader_handle: '',
    duration,
  })
}

/**
 * 追踪帖子互动
 */
export function trackPostEngagement(metrics: PostEngagementMetrics) {
  // Map action to supported action types
  const actionMap: Record<string, 'like' | 'unlike' | 'comment' | 'bookmark' | 'repost' | 'vote'> = {
    view: 'like', // Map view to like for tracking
    like: 'like',
    dislike: 'unlike',
    comment: 'comment',
    share: 'repost',
    bookmark: 'bookmark',
    vote: 'vote',
  }
  
  track('post_interaction', {
    post_id: metrics.postId,
    action: actionMap[metrics.action] || 'like',
  })
}

/**
 * 追踪搜索行为
 */
export function trackSearch(metrics: SearchMetrics) {
  track('search', {
    query: metrics.query,
    results_count: metrics.resultCount,
    selected_result: metrics.clickedResult,
  })
}

/**
 * 追踪转化事件
 */
export function trackConversion(metrics: ConversionMetrics) {
  track('performance', {
    metric_name: `conversion.${metrics.event}`,
    value: metrics.value || 0,
    page: metrics.source || 'unknown',
  })
}

/**
 * 追踪用户旅程步骤
 */
export function trackUserJourney(metrics: UserJourneyMetrics) {
  track('performance', {
    metric_name: `funnel.${metrics.funnel}.${metrics.step}`,
    value: metrics.success ? 1 : 0,
    page: 'funnel',
  })
}

/**
 * 追踪自定义性能指标
 */
export function trackPerformance(metrics: PerformanceMetrics) {
  track('performance', {
    metric_name: metrics.name,
    value: metrics.duration,
    page: 'performance',
  })
}

/**
 * 追踪关注/取消关注
 */
export function trackFollow(traderId: string, action: 'follow' | 'unfollow', _source?: string) {
  track('follow_trader', {
    trader_id: traderId,
    trader_handle: '', // Handle not always available
    action,
  })
}

/**
 * 追踪交易所绑定
 */
export function trackExchangeConnect(exchange: string, success: boolean) {
  track('exchange_bind', {
    exchange,
    action: success ? 'success' : 'fail',
  })
}

/**
 * 追踪错误（业务逻辑错误，非异常）
 */
export function trackBusinessError(error: string, _context?: Record<string, unknown>) {
  track('error', {
    error_type: 'business',
    error_message: error,
    page: typeof window !== 'undefined' ? window.location.pathname : 'unknown',
  })
}

// ============================================
// Web Vitals 追踪
// ============================================

/**
 * 追踪 Web Vitals 指标
 */
export function trackWebVital(
  name: 'FCP' | 'LCP' | 'FID' | 'CLS' | 'TTFB' | 'INP',
  value: number,
  _rating: 'good' | 'needs-improvement' | 'poor'
) {
  track('performance', {
    metric_name: `web_vital.${name.toLowerCase()}`,
    value,
    page: 'web_vitals',
  })
}

// ============================================
// 聚合指标
// ============================================

/**
 * 业务指标对象 - 便于集中调用
 */
export const BusinessMetrics = {
  trackTraderView,
  trackTraderViewDuration,
  trackPostEngagement,
  trackSearch,
  trackConversion,
  trackUserJourney,
  trackPerformance,
  trackFollow,
  trackExchangeConnect,
  trackBusinessError,
  trackWebVital,
}

export default BusinessMetrics
