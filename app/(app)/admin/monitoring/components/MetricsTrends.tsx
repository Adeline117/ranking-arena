'use client'

import { useCallback, useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'

interface TrendPoint {
  date: string
  value: number
}

interface TrendsData {
  pipelineSuccessRate: TrendPoint[]
  errorRate: TrendPoint[]
  activeUsers: TrendPoint[]
}

interface MetricsTrendsProps {
  accessToken: string
}

function MiniChart({ data, color, unit = '%', height = 80 }: {
  data: TrendPoint[]
  color: string
  unit?: string
  height?: number
}) {
  if (data.length === 0) {
    return (
      <Box style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text size="xs" color="tertiary">No data</Text>
      </Box>
    )
  }

  const max = Math.max(...data.map(d => d.value), 1)
  const barWidth = Math.max(12, Math.floor((100 / data.length)))

  return (
    <Box style={{ height, display: 'flex', alignItems: 'flex-end', gap: 2, padding: `0 ${tokens.spacing[1]}` }}>
      {data.map((point, i) => {
        const barHeight = Math.max(2, (point.value / max) * (height - 20))
        return (
          <Box
            key={i}
            title={`${point.date}: ${point.value}${unit}`}
            style={{
              flex: 1,
              maxWidth: `${barWidth}px`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <Text size="xs" color="tertiary" style={{ fontSize: '9px', lineHeight: 1 }}>
              {point.value}{unit}
            </Text>
            <Box
              style={{
                width: '100%',
                height: `${barHeight}px`,
                background: color,
                borderRadius: '2px',
                opacity: 0.8,
                transition: 'height 0.3s ease',
              }}
            />
          </Box>
        )
      })}
    </Box>
  )
}

function TrendCard({ title, data, color, unit = '%', latestLabel }: {
  title: string
  data: TrendPoint[]
  color: string
  unit?: string
  latestLabel?: string
}) {
  const latest = data.length > 0 ? data[data.length - 1].value : null

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[3] }}>
        <Text size="sm" weight="bold">{title}</Text>
        {latest !== null && (
          <Text size="lg" weight="bold" style={{ color }}>
            {latest}{unit}
          </Text>
        )}
      </Box>
      <MiniChart data={data} color={color} unit={unit} />
      {latestLabel && (
        <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2], textAlign: 'right' }}>
          {latestLabel}
        </Text>
      )}
    </Box>
  )
}

export default function MetricsTrends({ accessToken }: MetricsTrendsProps) {
  const [trends, setTrends] = useState<TrendsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadTrends = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch('/api/admin/metrics/trends?days=7', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error('Failed to fetch trends')
      const result = await res.json()
      if (result.ok) {
        setTrends(result.data)
      } else {
        setError(result.error || 'Unknown error')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trends')
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    loadTrends()
  }, [loadTrends])

  if (loading && !trends) {
    return (
      <Card title="Performance Trends (7 Days)">
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">Loading trends...</Text>
        </Box>
      </Card>
    )
  }

  if (error && !trends) {
    return (
      <Card title="Performance Trends (7 Days)">
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">{error}</Text>
          <Button variant="secondary" size="sm" onClick={loadTrends} style={{ marginTop: tokens.spacing[2] }}>
            Retry
          </Button>
        </Box>
      </Card>
    )
  }

  return (
    <Card title="Performance Trends (7 Days)">
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: tokens.spacing[4],
        }}
      >
        <TrendCard
          title="Pipeline Success Rate"
          data={trends?.pipelineSuccessRate || []}
          color={tokens.colors.accent.success}
          unit="%"
          latestLabel="Target: >95%"
        />
        <TrendCard
          title="Error Rate"
          data={trends?.errorRate || []}
          color={tokens.colors.accent.error}
          unit="%"
          latestLabel="Target: <5%"
        />
        <TrendCard
          title="New Users"
          data={trends?.activeUsers || []}
          color={tokens.colors.accent.brand}
          unit=""
          latestLabel="Daily new registrations"
        />
      </Box>
    </Card>
  )
}
