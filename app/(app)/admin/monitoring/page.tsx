'use client'

import { useCallback, useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import TopNav from '@/app/components/layout/TopNav'
import { useToast } from '@/app/components/ui/Toast'
import { useAdminAuth } from '../hooks/useAdminAuth'
import HealthScoreCard from './components/HealthScoreCard'
import AlertsPanel from './components/AlertsPanel'
import SchedulerMetrics from './components/SchedulerMetrics'
import AnomalyMetrics from './components/AnomalyMetrics'
import SystemMetrics from './components/SystemMetrics'
import MetricsTrends from './components/MetricsTrends'

interface SchedulerData {
  enabled: boolean
  tierDistribution?: Record<string, { count: number; percentage: string; refreshInterval: string }>
  apiEfficiency?: Record<string, unknown>
  dataFreshness?: { overdueTraders: number; lastTierUpdate?: string }
  error?: string
}

interface AnomalyData {
  enabled: boolean
  stats?: {
    total: number
    byStatus: Record<string, number>
    bySeverity: Record<string, number>
    byType: Record<string, number>
  }
  recentAnomalies?: Array<{
    id: string
    trader_id: string
    platform: string
    anomaly_type: string
    field_name: string
    severity: string
    status: string
    detected_at: string
  }>
  error?: string
}

interface SystemData {
  users?: {
    total: number
    newToday: number
    newYesterday: number
    banned: number
  }
  content?: {
    posts: {
      total: number
      newToday: number
      newYesterday: number
    }
    comments: {
      total: number
      newToday: number
    }
  }
  moderation?: {
    reports: {
      pending: number
      thisWeek: number
    }
    groups: {
      total: number
      pendingApplications: number
    }
  }
  scraperHealth?: {
    fresh: number
    stale: number
    critical: number
  }
  error?: string
}

interface MonitoringData {
  ok: boolean
  timestamp: string
  health: {
    score: number
    status: 'healthy' | 'warning' | 'critical'
    color: string
    message: string
  }
  alerts: {
    total: number
    critical: number
    warning: number
    items: Array<{
      id: string
      severity: 'info' | 'warning' | 'critical'
      title: string
      message: string
      timestamp: string
    }>
  }
  scheduler: SchedulerData
  anomalyDetection: AnomalyData
  system: SystemData
}

export default function MonitoringPage() {
  const { showToast } = useToast()
  const { email, accessToken, isAdmin, authChecking } = useAdminAuth()
  const [data, setData] = useState<MonitoringData | null>(null)
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)

  // Load monitoring data
  const loadData = useCallback(async () => {
    if (!accessToken) return

    try {
      setLoading(true)
      const response = await fetch('/api/admin/monitoring/overview', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })

      if (!response.ok) {
        throw new Error('Failed to fetch monitoring data')
      }

      const result = await response.json()
      setData(result)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load data'
      showToast(errorMessage, 'error')
    } finally {
      setLoading(false)
    }
  }, [accessToken, showToast])

  // Initial load
  useEffect(() => {
    if (accessToken && isAdmin) {
      loadData()
    }
  }, [accessToken, isAdmin, loadData])

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefresh || !accessToken) return

    const interval = setInterval(() => {
      loadData()
    }, 30000)

    return () => clearInterval(interval)
  }, [autoRefresh, accessToken, loadData])

  if (authChecking) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav email={null} />
        <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text>Verifying admin permissions...</Text>
        </Box>
      </Box>
    )
  }

  if (!isAdmin) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav email={email} />
        <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            Access Denied
          </Text>
          <Text color="tertiary">You do not have admin permissions to view this page.</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: '1400px', margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* Header */}
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.spacing[6],
          }}
        >
          <Box>
            <Text size="3xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
              Performance Monitoring
            </Text>
            <Text size="sm" color="tertiary">
              Real-time system health and performance metrics
            </Text>
          </Box>

          <Box style={{ display: 'flex', gap: tokens.spacing[3], alignItems: 'center' }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <input
                type="checkbox"
                id="auto-refresh"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <label htmlFor="auto-refresh" style={{ cursor: 'pointer' }}>
                <Text size="sm" color="secondary">
                  Auto-refresh (30s)
                </Text>
              </label>
            </Box>
            <Button variant="secondary" size="sm" onClick={loadData} disabled={loading}>
              {loading ? 'Refreshing...' : 'Refresh Now'}
            </Button>
          </Box>
        </Box>

        {loading && !data ? (
          <Card>
            <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
              <Text color="tertiary">Loading monitoring data...</Text>
            </Box>
          </Card>
        ) : data ? (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {/* Health Score & Alerts Row */}
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(300px, 1fr) 2fr',
                gap: tokens.spacing[4],
              }}
            >
              <HealthScoreCard health={data.health} timestamp={data.timestamp} />
              <AlertsPanel alerts={data.alerts} />
            </Box>

            {/* Scheduler Metrics */}
            <SchedulerMetrics data={data.scheduler} />

            {/* Anomaly Detection Metrics */}
            <AnomalyMetrics data={data.anomalyDetection} />

            {/* Performance Trends */}
            <MetricsTrends accessToken={accessToken!} />

            {/* System Metrics */}
            <SystemMetrics data={data.system} />
          </Box>
        ) : (
          <Card>
            <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
              <Text color="tertiary">No data available</Text>
            </Box>
          </Card>
        )}

        {/* Last updated */}
        {data && (
          <Box style={{ marginTop: tokens.spacing[4], textAlign: 'center' }}>
            <Text size="xs" color="tertiary">
              Last updated: {new Date(data.timestamp).toLocaleString()}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
