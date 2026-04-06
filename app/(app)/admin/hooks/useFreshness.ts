'use client'

import { useState, useCallback } from 'react'
import { logger } from '@/lib/logger'

export interface PlatformFreshnessStatus {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageMs: number | null
  ageHours: number | null
  status: 'fresh' | 'stale' | 'critical' | 'unknown'
  recordCount: number
}

export interface FreshnessReport {
  ok: boolean
  checked_at: string
  summary: {
    total: number
    fresh: number
    stale: number
    critical: number
    unknown: number
  }
  thresholds: {
    stale: string
    critical: string
  }
  platforms: PlatformFreshnessStatus[]
}

export function useFreshness() {
  const [freshnessReport, setFreshnessReport] = useState<FreshnessReport | null>(null)
  const [loading, setLoading] = useState(false)

  const loadFreshnessReport = useCallback(async () => {
    setLoading(true)
    
    try {
      const res = await fetch('/api/cron/check-data-freshness')
      const data = await res.json()
      setFreshnessReport(data)
    } catch (err) {
      logger.error('Error loading freshness report:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  return {
    freshnessReport,
    loading,
    loadFreshnessReport,
  }
}
