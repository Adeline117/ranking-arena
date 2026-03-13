/**
 * Pipeline Monitor - 数据管道监控工具
 *
 * 提供指标记录和查询功能，用于追踪各交易所数据源的健康状态。
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// ============================================
// Types
// ============================================

export type MetricType = 'fetch_success' | 'fetch_error' | 'fetch_duration' | 'record_count'

export interface PipelineMetric {
  source: string
  metric_type: MetricType
  value: number
  metadata?: Record<string, unknown>
}

export interface SourceHealth {
  source: string
  successRate: number        // 0-100
  errorRate: number          // 0-100
  lastFetchAt: string | null
  avgDuration: number        // ms
  totalRecords: number
  recentErrors: Array<{ created_at: string; metadata: Record<string, unknown> }>
  healthScore: number        // 0-100
  status: 'healthy' | 'degraded' | 'down'
}

export interface PipelineOverview {
  sources: SourceHealth[]
  overallHealth: number
  totalFetches: number
  totalErrors: number
  updatedAt: string
}

// ============================================
// Record Metrics
// ============================================

async function recordMetric(
  supabase: SupabaseClient,
  metric: PipelineMetric
): Promise<void> {
  const { error } = await supabase.from('pipeline_metrics').insert({
    source: metric.source,
    metric_type: metric.metric_type,
    value: metric.value,
    metadata: metric.metadata || {},
  })
  if (error) {
    logger.warn(`[pipeline-monitor] Failed to record metric: ${error.message}`)
  }
}

export async function recordFetchSuccess(
  supabase: SupabaseClient,
  source: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await recordMetric(supabase, {
    source,
    metric_type: 'fetch_success',
    value: 1,
    metadata,
  })
}

export async function recordFetchError(
  supabase: SupabaseClient,
  source: string,
  error: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await recordMetric(supabase, {
    source,
    metric_type: 'fetch_error',
    value: 1,
    metadata: { error, ...metadata },
  })
}

export async function recordFetchDuration(
  supabase: SupabaseClient,
  source: string,
  durationMs: number,
  metadata?: Record<string, unknown>
): Promise<void> {
  await recordMetric(supabase, {
    source,
    metric_type: 'fetch_duration',
    value: durationMs,
    metadata,
  })
}

export async function recordRecordCount(
  supabase: SupabaseClient,
  source: string,
  count: number,
  metadata?: Record<string, unknown>
): Promise<void> {
  await recordMetric(supabase, {
    source,
    metric_type: 'record_count',
    value: count,
    metadata,
  })
}

/**
 * 一次性记录一次抓取的所有指标
 */
export async function recordFetchResult(
  supabase: SupabaseClient,
  source: string,
  result: {
    success: boolean
    durationMs: number
    recordCount: number
    error?: string
    metadata?: Record<string, unknown>
  }
): Promise<void> {
  const promises: Promise<void>[] = []

  if (result.success) {
    promises.push(recordFetchSuccess(supabase, source, result.metadata))
  } else {
    promises.push(recordFetchError(supabase, source, result.error || 'unknown', result.metadata))
  }

  promises.push(recordFetchDuration(supabase, source, result.durationMs, result.metadata))

  if (result.recordCount > 0) {
    promises.push(recordRecordCount(supabase, source, result.recordCount, result.metadata))
  }

  await Promise.allSettled(promises)
}

// ============================================
// Query Metrics
// ============================================

export async function getSourceHealth(
  supabase: SupabaseClient,
  source: string,
  windowHours: number = 24
): Promise<SourceHealth> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()

  // 获取所有最近的指标
  const { data: metrics } = await supabase
    .from('pipeline_metrics')
    .select('metric_type, value, created_at, metadata')
    .eq('source', source)
    .gte('created_at', since)
    .order('created_at', { ascending: false })

  const rows = metrics || []

  const successes = rows.filter(r => r.metric_type === 'fetch_success')
  const errors = rows.filter(r => r.metric_type === 'fetch_error')
  const durations = rows.filter(r => r.metric_type === 'fetch_duration')
  const records = rows.filter(r => r.metric_type === 'record_count')

  const totalFetches = successes.length + errors.length
  const successRate = totalFetches > 0 ? (successes.length / totalFetches) * 100 : 0
  const errorRate = totalFetches > 0 ? (errors.length / totalFetches) * 100 : 0

  const avgDuration = durations.length > 0
    ? durations.reduce((sum, d) => sum + Number(d.value), 0) / durations.length
    : 0

  const totalRecords = records.reduce((sum, r) => sum + Number(r.value), 0)

  const lastFetchAt = rows.length > 0 ? rows[0].created_at : null

  const recentErrors = errors.slice(0, 10).map(e => ({
    created_at: e.created_at,
    metadata: (e as Record<string, unknown>).metadata as Record<string, unknown> | undefined,
  }))

  // 健康分数计算
  const healthScore = calculateHealthScore(successRate, lastFetchAt, errorRate)

  return {
    source,
    successRate: Math.round(successRate * 100) / 100,
    errorRate: Math.round(errorRate * 100) / 100,
    lastFetchAt,
    avgDuration: Math.round(avgDuration),
    totalRecords,
    recentErrors,
    healthScore,
    status: healthScore >= 80 ? 'healthy' : healthScore >= 50 ? 'degraded' : 'down',
  }
}

function calculateHealthScore(
  successRate: number,
  lastFetchAt: string | null,
  errorRate: number
): number {
  // 成功率权重: 60%
  const successScore = successRate * 0.6

  // 新鲜度权重: 25% (最近1小时=满分, 超过6小时=0分)
  let freshnessScore = 0
  if (lastFetchAt) {
    const hoursSince = (Date.now() - new Date(lastFetchAt).getTime()) / (1000 * 60 * 60)
    freshnessScore = Math.max(0, Math.min(25, 25 * (1 - hoursSince / 6)))
  }

  // 错误率惩罚: 15% (0错误=满分)
  const errorPenalty = 15 * (1 - errorRate / 100)

  return Math.round(Math.min(100, successScore + freshnessScore + errorPenalty))
}

export async function getPipelineOverview(
  supabase: SupabaseClient,
  windowHours: number = 24
): Promise<PipelineOverview> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()

  // 获取所有源
  const { data: sourcesData } = await supabase
    .from('pipeline_metrics')
    .select('source')
    .gte('created_at', since)

  const uniqueSources = [...new Set((sourcesData || []).map(r => r.source))]

  const sources = await Promise.all(
    uniqueSources.map(source => getSourceHealth(supabase, source, windowHours))
  )

  sources.sort((a, b) => a.source.localeCompare(b.source))

  const totalFetches = sources.reduce((sum, s) => {
    const total = Math.round(s.successRate > 0 || s.errorRate > 0
      ? 100 / (s.successRate || 1) * (s.successRate / 100)
      : 0)
    return sum + total
  }, 0)

  const totalErrors = sources.reduce((sum, s) => s.recentErrors.length + sum, 0)

  const overallHealth = sources.length > 0
    ? Math.round(sources.reduce((sum, s) => sum + s.healthScore, 0) / sources.length)
    : 0

  return {
    sources,
    overallHealth,
    totalFetches,
    totalErrors,
    updatedAt: new Date().toISOString(),
  }
}

export async function getErrorRate(
  supabase: SupabaseClient,
  source: string,
  windowHours: number = 24
): Promise<number> {
  const health = await getSourceHealth(supabase, source, windowHours)
  return health.errorRate
}
