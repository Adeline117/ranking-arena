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
import { withCron } from '@/lib/api/with-cron'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface Anomaly {
  anomaly_type: string
  platform: string
  detail: string
  severity: string
  count: number
}

const SCAN_WORK_BUDGET_MS = 30_000
const MAX_ALERT_ITEMS = 10
const ANOMALY_SEVERITIES = new Set(['critical', 'warning', 'info'])

function parseAnomalies(payload: unknown): Anomaly[] {
  if (!Array.isArray(payload)) {
    throw new Error('scan_data_quality_anomalies returned a non-array payload')
  }

  return payload.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`scan_data_quality_anomalies returned an invalid row at index ${index}`)
    }

    const row = value as Partial<Anomaly>
    if (
      typeof row.anomaly_type !== 'string' ||
      row.anomaly_type.trim().length === 0 ||
      typeof row.platform !== 'string' ||
      row.platform.trim().length === 0 ||
      typeof row.detail !== 'string' ||
      typeof row.severity !== 'string' ||
      !ANOMALY_SEVERITIES.has(row.severity) ||
      typeof row.count !== 'number' ||
      !Number.isInteger(row.count) ||
      row.count < 0
    ) {
      throw new Error(`scan_data_quality_anomalies returned a malformed row at index ${index}`)
    }

    return row as Anomaly
  })
}

function alertText(value: string, maxLength: number): string {
  const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  if (escaped.length <= maxLength) return escaped

  let truncated = escaped.slice(0, maxLength)
  if (truncated.lastIndexOf('&') > truncated.lastIndexOf(';')) {
    truncated = truncated.slice(0, truncated.lastIndexOf('&'))
  }
  return `${truncated}…`
}

export const GET = withCron(
  'scan-data-quality',
  async (_request: NextRequest, { supabase }) => {
    const workSignal = AbortSignal.timeout(SCAN_WORK_BUDGET_MS)

    const { data, error } = await supabase
      .rpc('scan_data_quality_anomalies')
      .abortSignal(workSignal)

    if (error) {
      throw new Error(`scan_data_quality_anomalies failed: ${error.message}`)
    }
    workSignal.throwIfAborted()

    const anomalies = parseAnomalies(data)

    if (anomalies.length === 0) {
      return { count: 0, message: 'No anomalies detected' }
    }

    // Alert on critical anomalies
    const critical = anomalies.filter((anomaly) => anomaly.severity === 'critical')
    if (critical.length > 0) {
      const { sendRateLimitedAlert } = await import('@/lib/alerts/send-alert')
      const orderedAnomalies = [
        ...critical,
        ...anomalies.filter((anomaly) => anomaly.severity !== 'critical'),
      ]
      const alertAnomalies = orderedAnomalies.slice(0, MAX_ALERT_ITEMS)
      const omitted = anomalies.length - alertAnomalies.length
      const summary = alertAnomalies
        .map(
          (anomaly) =>
            `  [${alertText(anomaly.severity, 16)}] ${alertText(anomaly.platform, 48)}: ` +
            `${alertText(anomaly.anomaly_type, 72)} — ${alertText(anomaly.detail, 160)}`
        )
        .join('\n')
      const alertResult = await sendRateLimitedAlert(
        {
          title: `数据质量异常: ${anomalies.length} 个问题`,
          message:
            `统计异常扫描发现以下问题:\n${summary}` +
            (omitted > 0 ? `\n  …另有 ${omitted} 个问题，请查看 pipeline log` : ''),
          level: 'critical',
          details: {
            anomaly_count: anomalies.length,
            critical_count: critical.length,
            omitted_from_message: omitted,
          },
        },
        'scan-data-quality',
        12 * 60 * 60 * 1000
      ) // Max 1 alert per 12h
      if (!alertResult.handled) {
        throw new Error('Critical data quality alert delivery failed')
      }
      workSignal.throwIfAborted()
    }

    return { count: anomalies.length, anomalies }
  },
  { safetyTimeoutMs: 55_000 }
)
