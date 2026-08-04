/**
 * Anomaly Manager Service
 * High-level API for managing trader anomalies with database persistence
 *
 * @module lib/services/anomaly-manager
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

// ============================================
// Types
// ============================================

export type SeverityLevel = 'low' | 'medium' | 'high' | 'critical'

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

function getSupabaseClient(): SupabaseClient {
  return getSupabaseAdmin()
}

// ============================================
// Database Operations
// ============================================

/**
 * Get all anomalies with filtering
 */
export async function getAllAnomalies(
  options?: GetAnomaliesOptions & { platform?: string }
): Promise<Anomaly[]> {
  const supabase = getSupabaseClient()

  let query = supabase
    .from('trader_anomalies')
    .select(
      'id, trader_id, platform, anomaly_type, field_name, detected_value, expected_range_min, expected_range_max, z_score, severity, status, description, metadata, detected_at'
    )
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

  const { error } = await supabase.from('trader_anomalies').update(updateData).eq('id', anomalyId)

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
