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

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface Anomaly {
  anomaly_type: string
  platform: string
  detail: string
  severity: string
  sample_count: number
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const plog = await PipelineLogger.start('scan-data-quality')

  try {
    const { data, error } = await supabase.rpc('scan_data_quality_anomalies')

    if (error) {
      await plog.error(new Error(error.message))
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const anomalies = (data || []) as Anomaly[]

    if (anomalies.length === 0) {
      await plog.success(0, { message: 'No anomalies detected' })
      return NextResponse.json({ clean: true, anomalies: 0 })
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
      } catch {
        // Alert delivery is best-effort
      }
    }

    await plog.success(anomalies.length, { anomalies })
    return NextResponse.json({ anomalies: anomalies.length, details: anomalies })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await plog.error(err instanceof Error ? err : new Error(msg))
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
