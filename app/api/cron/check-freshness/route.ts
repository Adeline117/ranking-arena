/**
 * 数据新鲜度告警 API (轻量版，供外部监控调用)
 * 
 * GET /api/cron/check-freshness
 * 
 * 阈值: CEX > 2h = stale, DEX > 4h = stale
 * 返回告警列表，可被 UptimeRobot / Betterstack 等定期调用
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const maxDuration = 60

// DEX 平台集合
const DEX_PLATFORMS = new Set([
  'gmx', 'gains', 'okx_web3', 'binance_web3',
])

// 阈值（小时）
const THRESHOLDS = {
  cex: { stale: 2, critical: 8 },
  dex: { stale: 4, critical: 12 },
}

interface Alert {
  platform: string
  type: 'cex' | 'dex'
  level: 'stale' | 'critical'
  lastUpdate: string
  ageHours: number
  thresholdHours: number
}

export async function GET(req: Request) {
  // Auth via CRON_SECRET
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')
    if (token !== cronSecret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })

  const plog = await PipelineLogger.start('check-freshness')

  try {
    // Get latest update per platform from trader_sources (fast)
    const { data: sources, error } = await supabase
      .from('trader_sources')
      .select('source, updated_at')
      .not('updated_at', 'is', null)

    if (error) throw error

    // Aggregate latest per platform
    const latestByPlatform = new Map<string, string>()
    for (const s of sources || []) {
      const existing = latestByPlatform.get(s.source)
      if (!existing || s.updated_at > existing) {
        latestByPlatform.set(s.source, s.updated_at)
      }
    }

    const now = Date.now()
    const alerts: Alert[] = []
    const platformStatuses: Array<{
      platform: string
      type: 'cex' | 'dex'
      lastUpdate: string
      ageHours: number
      status: 'fresh' | 'stale' | 'critical'
    }> = []

    for (const [platform, lastUpdate] of latestByPlatform) {
      const isDex = DEX_PLATFORMS.has(platform)
      const type = isDex ? 'dex' : 'cex'
      const threshold = THRESHOLDS[type]
      const ageMs = now - new Date(lastUpdate).getTime()
      const ageHours = Math.round(ageMs / 36e5 * 10) / 10

      let status: 'fresh' | 'stale' | 'critical' = 'fresh'

      if (ageHours >= threshold.critical) {
        status = 'critical'
        alerts.push({ platform, type, level: 'critical', lastUpdate, ageHours, thresholdHours: threshold.critical })
      } else if (ageHours >= threshold.stale) {
        status = 'stale'
        alerts.push({ platform, type, level: 'stale', lastUpdate, ageHours, thresholdHours: threshold.stale })
      }

      platformStatuses.push({ platform, type, lastUpdate, ageHours, status })
    }

    // Sort alerts by severity then age
    alerts.sort((a, b) => {
      if (a.level !== b.level) return a.level === 'critical' ? -1 : 1
      return b.ageHours - a.ageHours
    })

    const ok = alerts.length === 0

    await plog.success(platformStatuses.length, {
      fresh: platformStatuses.filter(p => p.status === 'fresh').length,
      stale: alerts.filter(a => a.level === 'stale').length,
      critical: alerts.filter(a => a.level === 'critical').length,
    })

    return NextResponse.json({
      ok,
      checked_at: new Date().toISOString(),
      thresholds: THRESHOLDS,
      alerts,
      summary: {
        total: platformStatuses.length,
        fresh: platformStatuses.filter(p => p.status === 'fresh').length,
        stale: alerts.filter(a => a.level === 'stale').length,
        critical: alerts.filter(a => a.level === 'critical').length,
      },
      platforms: platformStatuses.sort((a, b) => a.platform.localeCompare(b.platform)),
    }, {
      // Return 200 even with alerts - monitoring tools check the JSON body
      // Use 200 so this works as a standard healthcheck endpoint
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (e: unknown) {
    await plog.error(e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
