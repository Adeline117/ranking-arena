/**
 * Anomaly Detection Cron Job
 * Periodically scans active traders for data anomalies
 *
 * Schedule: Daily at 3 AM UTC
 * Configured in: vercel.json
 *
 * @module app/api/cron/detect-anomalies
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  batchDetectAnomalies,
  saveAnomalies,
  type TraderData,
} from '@/lib/services/anomaly-manager'
import logger from '@/lib/logger'

// Verify cron secret
function verifyCronSecret(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    // Only allow without secret in development
    if (process.env.NODE_ENV === 'development') return true
    logger.error('CRON_SECRET not configured in production')
    return false
  }

  return authHeader === `Bearer ${cronSecret}`
}

// Initialize Supabase client
function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase credentials')
  }

  return createClient(supabaseUrl, supabaseKey)
}

// Get active traders from database
async function getActiveTraders(): Promise<TraderData[]> {
  const supabase = getSupabaseClient()

  // Get traders with recent snapshots (within last 7 days)
  // Focus on hot and active tiers for efficiency
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select(`
      source_trader_id,
      source,
      roi,
      pnl,
      win_rate,
      max_drawdown,
      trades_count
    `)
    .gte('captured_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('captured_at', { ascending: false })

  if (error) {
    logger.error('Failed to fetch active traders:', error)
    throw new Error(`Failed to fetch active traders: ${error.message}`)
  }

  if (!data || data.length === 0) {
    return []
  }

  // Deduplicate by trader_id (keep latest)
  const traderMap = new Map<string, TraderData>()

  for (const snapshot of data) {
    const key = `${snapshot.source_trader_id}:${snapshot.source}`

    if (!traderMap.has(key)) {
      traderMap.set(key, {
        id: snapshot.source_trader_id,
        platform: snapshot.source,
        roi: Number(snapshot.roi) || 0,
        pnl: Number(snapshot.pnl) || 0,
        win_rate: snapshot.win_rate ? Number(snapshot.win_rate) : null,
        max_drawdown: snapshot.max_drawdown ? Number(snapshot.max_drawdown) : null,
        trades_count: snapshot.trades_count ? Number(snapshot.trades_count) : null,
      })
    }
  }

  return Array.from(traderMap.values())
}

// Main handler
export async function GET(request: NextRequest) {
  const startTime = Date.now()

  // Verify authorization
  if (!verifyCronSecret(request)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    )
  }

  // Check if anomaly detection is enabled
  const enabled = process.env.ENABLE_ANOMALY_DETECTION !== 'false'
  if (!enabled) {
    return NextResponse.json({
      success: true,
      message: 'Anomaly detection is disabled',
      stats: { skipped: true },
    })
  }

  try {

    // 1. Fetch active traders
    const traders = await getActiveTraders()

    if (traders.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No active traders to check',
        stats: {
          tradersChecked: 0,
          anomaliesDetected: 0,
          criticalAnomalies: 0,
          duration: Date.now() - startTime,
        },
      })
    }

    // 2. Batch detect anomalies
    const anomaliesMap = await batchDetectAnomalies(traders)

    // 3. Save anomalies to database
    let totalAnomalies = 0
    let criticalCount = 0

    for (const [_traderId, anomalies] of anomaliesMap) {
      if (anomalies.length > 0) {
        await saveAnomalies(anomalies)
        totalAnomalies += anomalies.length

        // Count critical anomalies
        const critical = anomalies.filter(a => a.severity === 'critical' || a.severity === 'high')
        criticalCount += critical.length

      }
    }

    const duration = Date.now() - startTime


    return NextResponse.json({
      success: true,
      message: 'Anomaly detection completed successfully',
      stats: {
        tradersChecked: traders.length,
        tradersWithAnomalies: anomaliesMap.size,
        anomaliesDetected: totalAnomalies,
        criticalAnomalies: criticalCount,
        duration,
      },
    })
  } catch (error: unknown) {
    logger.error('[Anomaly Detection] Error:', error)

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        stats: {
          duration: Date.now() - startTime,
        },
      },
      { status: 500 }
    )
  }
}

// Allow POST for manual triggering
export async function POST(request: NextRequest) {
  return GET(request)
}
