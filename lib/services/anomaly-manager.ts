/**
 * Anomaly Manager Service
 * High-level API for managing trader anomalies with database persistence
 *
 * @module lib/services/anomaly-manager
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  detectMultiDimensional,
  detectAnomaliesForAll,
  type AnomalyResult,
  type SeverityLevel,
} from './anomaly-detection'
import type { TraderRankingData } from '../utils/ranking'
import { logger } from '@/lib/logger'

// ============================================
// Types
// ============================================

export interface TraderData {
  id: string
  platform: string
  roi: number
  pnl: number
  win_rate?: number | null
  max_drawdown?: number | null
  trades_count?: number | null
}

export interface Anomaly {
  id?: string
  trader_id: string
  platform: string
  anomaly_type: string
  field_name: string
  detected_value: number | null
  expected_range_min?: number | null
  expected_range_max?: number | null
  z_score?: number | null
  severity: SeverityLevel
  status?: 'pending' | 'confirmed' | 'false_positive' | 'resolved'
  description: string
  metadata?: Record<string, unknown>
}

export interface AnomalyStats {
  total_anomalies: number
  by_severity: {
    critical: number
    high: number
    medium: number
    low: number
  }
  by_status: {
    pending: number
    confirmed: number
    false_positive: number
    resolved: number
  }
  by_platform: Record<string, number>
  affected_traders: number
  last_24h: number
  last_7d: number
}

export interface GetAnomaliesOptions {
  status?: 'pending' | 'confirmed' | 'false_positive' | 'resolved'
  severity?: SeverityLevel
  limit?: number
  offset?: number
}

// ============================================
// Supabase Client Initialization
// ============================================

let supabaseClient: SupabaseClient | null = null

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase credentials')
    }

    supabaseClient = createClient(supabaseUrl, supabaseKey)
  }

  return supabaseClient
}

// ============================================
// Conversion Utilities
// ============================================

function convertToTraderRankingData(trader: TraderData): TraderRankingData {
  return {
    id: trader.id,
    roi: trader.roi,
    pnl: trader.pnl,
    win_rate: trader.win_rate ?? null,
    max_drawdown: trader.max_drawdown ?? null,
    trades_count: trader.trades_count ?? null,
    source: trader.platform,
  }
}

function convertAnomalyResultToDbFormat(
  result: AnomalyResult,
  platform: string
): Anomaly[] {
  const anomalies: Anomaly[] = []

  for (const detail of result.details) {
    anomalies.push({
      trader_id: result.traderId,
      platform,
      anomaly_type: result.anomalyType.join(','),
      field_name: detail.field,
      detected_value: detail.value,
      z_score: detail.zScore ?? null,
      severity: result.severity,
      status: 'pending',
      description: detail.description,
      metadata: {
        anomaly_score: result.anomalyScore,
        confidence: result.confidence,
        all_anomaly_types: result.anomalyType,
      },
    })
  }

  return anomalies
}

// ============================================
// Core Detection Functions
// ============================================

/**
 * Detect anomalies for a single trader
 */
export async function detectTraderAnomalies(
  traderId: string,
  platform: string,
  data: TraderData,
  allTraders?: TraderData[]
): Promise<Anomaly[]> {
  // Convert to internal format
  const trader = convertToTraderRankingData(data)

  // If no comparison set provided, use just this trader (limited detection)
  const tradersForComparison = allTraders
    ? allTraders.map(convertToTraderRankingData)
    : [trader]

  // Run detection
  const result = detectMultiDimensional(trader, tradersForComparison)

  // Convert to database format
  if (result.isAnomaly) {
    return convertAnomalyResultToDbFormat(result, platform)
  }

  return []
}

/**
 * Batch detect anomalies for multiple traders
 */
export async function batchDetectAnomalies(
  traders: TraderData[]
): Promise<Map<string, Anomaly[]>> {
  const anomaliesMap = new Map<string, Anomaly[]>()

  if (traders.length === 0) {
    return anomaliesMap
  }

  // Convert all traders
  const tradersForDetection = traders.map(convertToTraderRankingData)

  // Run batch detection
  const results = detectAnomaliesForAll(tradersForDetection)

  // Convert results to database format
  for (const trader of traders) {
    const result = results.get(trader.id)
    if (result && result.isAnomaly) {
      const anomalies = convertAnomalyResultToDbFormat(result, trader.platform)
      anomaliesMap.set(trader.id, anomalies)
    }
  }

  return anomaliesMap
}

// ============================================
// Database Operations
// ============================================

/**
 * Save anomalies to database
 */
export async function saveAnomalies(anomalies: Anomaly[]): Promise<void> {
  if (anomalies.length === 0) return

  const supabase = getSupabaseClient()

  const { error } = await supabase
    .from('trader_anomalies')
    .insert(anomalies)

  if (error) {
    logger.error('Failed to save anomalies:', error)
    throw new Error(`Failed to save anomalies: ${error.message}`)
  }
}

/**
 * Get anomalies for a specific trader
 */
export async function getTraderAnomalies(
  traderId: string,
  platform: string,
  options?: GetAnomaliesOptions
): Promise<Anomaly[]> {
  const supabase = getSupabaseClient()

  let query = supabase
    .from('trader_anomalies')
    .select('*')
    .eq('trader_id', traderId)
    .eq('platform', platform)
    .order('detected_at', { ascending: false })

  if (options?.status) {
    query = query.eq('status', options.status)
  }

  if (options?.severity) {
    query = query.eq('severity', options.severity)
  }

  if (options?.limit) {
    query = query.limit(options.limit)
  }

  if (options?.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 10) - 1)
  }

  const { data, error } = await query

  if (error) {
    logger.error('Failed to fetch trader anomalies:', error)
    throw new Error(`Failed to fetch trader anomalies: ${error.message}`)
  }

  return data || []
}

/**
 * Get all anomalies with filtering
 */
export async function getAllAnomalies(
  options?: GetAnomaliesOptions & { platform?: string }
): Promise<Anomaly[]> {
  const supabase = getSupabaseClient()

  let query = supabase
    .from('trader_anomalies')
    .select('*')
    .order('detected_at', { ascending: false })

  if (options?.platform) {
    query = query.eq('platform', options.platform)
  }

  if (options?.status) {
    query = query.eq('status', options.status)
  }

  if (options?.severity) {
    query = query.eq('severity', options.severity)
  }

  if (options?.limit) {
    query = query.limit(options.limit)
  }

  if (options?.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1)
  }

  const { data, error } = await query

  if (error) {
    logger.error('Failed to fetch anomalies:', error)
    throw new Error(`Failed to fetch anomalies: ${error.message}`)
  }

  return data || []
}

/**
 * Update anomaly status
 */
export async function updateAnomalyStatus(
  anomalyId: string,
  status: 'confirmed' | 'false_positive' | 'resolved',
  notes?: string,
  resolvedBy?: string
): Promise<void> {
  const supabase = getSupabaseClient()

  const updateData: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }

  if (notes) {
    updateData.notes = notes
  }

  if (resolvedBy) {
    updateData.resolved_by = resolvedBy
  }

  if (status === 'resolved' || status === 'false_positive') {
    updateData.resolved_at = new Date().toISOString()
  }

  const { error } = await supabase
    .from('trader_anomalies')
    .update(updateData)
    .eq('id', anomalyId)

  if (error) {
    logger.error('Failed to update anomaly status:', error)
    throw new Error(`Failed to update anomaly status: ${error.message}`)
  }
}

/**
 * Get anomaly statistics
 */
export async function getAnomalyStats(): Promise<AnomalyStats> {
  const supabase = getSupabaseClient()

  // Get all anomalies for stats
  const { data: anomalies, error } = await supabase
    .from('trader_anomalies')
    .select('severity, status, platform, detected_at, trader_id')

  if (error) {
    logger.error('Failed to fetch anomaly stats:', error)
    throw new Error(`Failed to fetch anomaly stats: ${error.message}`)
  }

  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  const stats: AnomalyStats = {
    total_anomalies: anomalies?.length || 0,
    by_severity: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    by_status: {
      pending: 0,
      confirmed: 0,
      false_positive: 0,
      resolved: 0,
    },
    by_platform: {},
    affected_traders: 0,
    last_24h: 0,
    last_7d: 0,
  }

  if (!anomalies) return stats

  const uniqueTraders = new Set<string>()

  for (const anomaly of anomalies) {
    // By severity
    if (anomaly.severity in stats.by_severity) {
      stats.by_severity[anomaly.severity as keyof typeof stats.by_severity]++
    }

    // By status
    if (anomaly.status in stats.by_status) {
      stats.by_status[anomaly.status as keyof typeof stats.by_status]++
    }

    // By platform
    stats.by_platform[anomaly.platform] = (stats.by_platform[anomaly.platform] || 0) + 1

    // Unique traders
    uniqueTraders.add(`${anomaly.trader_id}:${anomaly.platform}`)

    // Time-based
    const detectedAt = new Date(anomaly.detected_at)
    if (detectedAt >= yesterday) {
      stats.last_24h++
    }
    if (detectedAt >= lastWeek) {
      stats.last_7d++
    }
  }

  stats.affected_traders = uniqueTraders.size

  return stats
}

/**
 * Check if trader should be flagged as suspicious
 */
export async function checkTraderSuspicion(
  traderId: string,
  platform: string
): Promise<boolean> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .rpc('check_trader_suspicion', {
      p_trader_id: traderId,
      p_platform: platform,
    })

  if (error) {
    logger.error('Failed to check trader suspicion:', error)
    return false
  }

  return data as boolean
}

/**
 * Get pending critical anomalies count
 */
export async function getPendingCriticalCount(): Promise<number> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .rpc('get_pending_critical_anomalies_count')

  if (error) {
    logger.error('Failed to get pending critical count:', error)
    return 0
  }

  return data as number
}

/**
 * Delete old resolved/false positive anomalies
 */
export async function cleanupOldAnomalies(daysOld: number = 90): Promise<number> {
  const supabase = getSupabaseClient()

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - daysOld)

  const { data, error } = await supabase
    .from('trader_anomalies')
    .delete()
    .in('status', ['resolved', 'false_positive'])
    .lt('resolved_at', cutoffDate.toISOString())
    .select('id')

  if (error) {
    logger.error('Failed to cleanup old anomalies:', error)
    throw new Error(`Failed to cleanup old anomalies: ${error.message}`)
  }

  return data?.length || 0
}
