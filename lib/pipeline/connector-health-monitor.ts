/**
 * Connector Health Monitor
 *
 * Compares each batch-fetch run against the previous run for the same platform+window.
 * Detects: row count drops, median ROI shifts, field completeness changes.
 * Alerts via Telegram. Blocks writes on critical degradation.
 */

import { PipelineState } from '@/lib/services/pipeline-state'
import { logger } from '@/lib/logger'

export interface ConnectorHealthSnapshot {
  platform: string
  window: string
  timestamp: string
  rowCount: number
  medianRoi: number | null
  roiNonNullPct: number
  pnlNonNullPct: number
}

export interface DegradationCheck {
  isDegraded: boolean
  severity: 'none' | 'warning' | 'critical'
  reasons: string[]
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function computeSnapshot(
  platform: string,
  window: string,
  rows: Array<Record<string, unknown>>,
): ConnectorHealthSnapshot {
  const rois = rows.map(r => Number(r.roi_pct ?? r.roi)).filter(Number.isFinite)
  const pnls = rows.map(r => r.pnl_usd ?? r.pnl).filter(v => v != null)

  return {
    platform,
    window,
    timestamp: new Date().toISOString(),
    rowCount: rows.length,
    medianRoi: median(rois),
    roiNonNullPct: rows.length > 0 ? (rois.length / rows.length) * 100 : 0,
    pnlNonNullPct: rows.length > 0 ? (pnls.length / rows.length) * 100 : 0,
  }
}

/**
 * Check if the current batch shows degradation vs the previous run.
 */
export async function checkConnectorHealth(
  platform: string,
  window: string,
  currentRows: Array<Record<string, unknown>>,
): Promise<DegradationCheck> {
  const reasons: string[] = []
  let severity = 'none' as string

  const current = computeSnapshot(platform, window, currentRows)
  const stateKey = `connector-health:${platform}:${window}`

  let previous: ConnectorHealthSnapshot | null = null
  try {
    const stored = await PipelineState.get<ConnectorHealthSnapshot>(stateKey)
    previous = stored
  } catch {
    // No previous — first run, skip comparison
  }

  if (!previous || previous.rowCount === 0) {
    // First run or empty previous — save baseline and pass
    await saveSnapshot(stateKey, current)
    return { isDegraded: false, severity: 'none', reasons: [] }
  }

  // ── Row count drop ──
  if (previous.rowCount >= 50 && current.rowCount < previous.rowCount * 0.5) {
    reasons.push(`Row count dropped ${previous.rowCount} → ${current.rowCount} (>${50}% drop)`)
    severity = 'critical'
  } else if (previous.rowCount >= 20 && current.rowCount < previous.rowCount * 0.7) {
    reasons.push(`Row count dropped ${previous.rowCount} → ${current.rowCount} (>${30}% drop)`)
    if (severity !== 'critical') severity = 'warning'
  }

  // ── Median ROI shift ──
  if (previous.medianRoi != null && current.medianRoi != null && Math.abs(previous.medianRoi) > 1) {
    const shift = Math.abs(current.medianRoi - previous.medianRoi) / Math.abs(previous.medianRoi)
    if (shift > 5) {
      reasons.push(`Median ROI shifted ${previous.medianRoi.toFixed(1)}% → ${current.medianRoi.toFixed(1)}% (${(shift * 100).toFixed(0)}% change)`)
      severity = 'critical'
    } else if (shift > 2) {
      reasons.push(`Median ROI shifted ${previous.medianRoi.toFixed(1)}% → ${current.medianRoi.toFixed(1)}% (${(shift * 100).toFixed(0)}% change)`)
      if (severity !== 'critical') severity = 'warning'
    }
  }

  // ── Field completeness drop ──
  if (previous.roiNonNullPct > 80 && current.roiNonNullPct < 20) {
    reasons.push(`ROI completeness dropped ${previous.roiNonNullPct.toFixed(0)}% → ${current.roiNonNullPct.toFixed(0)}%`)
    severity = 'critical'
  }

  if (reasons.length > 0) {
    logger.warn(`[connector-health] ${platform}/${window} ${severity}: ${reasons.join('; ')}`)
  }

  // Always save the new snapshot (even when degraded)
  await saveSnapshot(stateKey, current)

  return { isDegraded: severity !== 'none', severity: severity as DegradationCheck['severity'], reasons }
}

async function saveSnapshot(key: string, snapshot: ConnectorHealthSnapshot): Promise<void> {
  try {
    await PipelineState.set(key, snapshot)
  } catch (err) {
    logger.warn('[connector-health] Failed to save snapshot:', err)
  }
}
