/**
 * GET /api/cron/scan-data-quality
 *
 * Statistical anomaly detection for data quality issues that validators can't catch.
 * Detects: stale scrapers, decimal confusion, broken enrichment, distribution shifts.
 *
 * Alerts via Telegram when anomalies are found. Self-documents in pipeline_logs.
 *
 * Schedule: Daily at 06:00 UTC
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withCron } from '@/lib/api/with-cron'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface Anomaly {
  anomaly_type: string
  platform: string
  detail: string
  severity: string
  sample_count: number
}

export const GET = withCron('scan-data-quality', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin() as SupabaseClient

  const { data, error } = await supabase.rpc('scan_data_quality_anomalies')

  if (error) {
    throw new Error(error.message)
  }

  const anomalies = (data || []) as Anomaly[]

  if (anomalies.length === 0) {
    return { count: 0, message: 'No anomalies detected' }
  }

  // Alert on critical anomalies
  const critical = anomalies.filter(a => a.severity === 'critical')
  if (critical.length > 0) {
    try {
      const { sendRateLimitedAlert } = await import('@/lib/alerts/send-alert')
      const summary = anomalies.map(a =>
        `  [${a.severity}] ${a.platform}: ${a.anomaly_type} — ${a.detail}`
      ).join('\n')
      await sendRateLimitedAlert({
        title: `数据质量异常: ${anomalies.length} 个问题`,
        message: `统计异常扫描发现以下问题:\n${summary}`,
        level: 'critical',
        details: { anomalies },
      }, 'scan-data-quality', 12 * 60 * 60 * 1000) // Max 1 alert per 12h
    } catch (alertErr) {
      // Best-effort for the cron result, but we still want Sentry to see
      // that the daily anomaly scan could not notify operators.
      logger.error('[scan-data-quality] Failed to deliver Telegram alert', {
        error: alertErr instanceof Error ? alertErr.message : String(alertErr),
        anomalyCount: anomalies.length,
        criticalCount: critical.length,
      })
    }
  }

  return { count: anomalies.length, anomalies }
})
