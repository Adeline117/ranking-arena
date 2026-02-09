'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Card from '@/app/components/ui/Card'

interface AnomalyMetricsProps {
  data: {
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
}

const SEVERITY_COLORS = {
  critical: 'var(--color-accent-error)',
  high: 'var(--color-chart-orange)',
  medium: 'var(--color-medal-gold)',
  low: 'var(--color-chart-green)',
}

export default function AnomalyMetrics({ data }: AnomalyMetricsProps) {
  if (!data.enabled) {
    return (
      <Card title="Anomaly Detection">
        <Box
          style={{
            padding: tokens.spacing[6],
            textAlign: 'center',
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.md,
          }}
        >
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
            Anomaly Detection is currently disabled
          </Text>
          <Text size="xs" color="tertiary">
            Set ENABLE_ANOMALY_DETECTION=true to enable automated data quality monitoring
          </Text>
        </Box>
      </Card>
    )
  }

  if (data.error) {
    return (
      <Card title="Anomaly Detection">
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">
            {data.error}
          </Text>
        </Box>
      </Card>
    )
  }

  const { stats, recentAnomalies } = data

  return (
    <Card title="Anomaly Detection Status">
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {/* Overview Stats */}
        <Box>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            Detection Overview
          </Text>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: tokens.spacing[3],
            }}
          >
            <StatBox
              title="Total Anomalies"
              value={stats?.total || 0}
              color={tokens.colors.text.primary}
            />
            <StatBox
              title="Pending Review"
              value={stats?.byStatus?.pending || 0}
              color={SEVERITY_COLORS.medium}
            />
            <StatBox
              title="Under Investigation"
              value={stats?.byStatus?.investigating || 0}
              color={SEVERITY_COLORS.high}
            />
            <StatBox
              title="Resolved"
              value={stats?.byStatus?.resolved || 0}
              color={SEVERITY_COLORS.low}
            />
          </Box>
        </Box>

        {/* By Severity */}
        <Box>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            By Severity
          </Text>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: tokens.spacing[3],
            }}
          >
            <SeverityBox
              label="Critical"
              count={stats?.bySeverity?.critical || 0}
              color={SEVERITY_COLORS.critical}
            />
            <SeverityBox
              label="High"
              count={stats?.bySeverity?.high || 0}
              color={SEVERITY_COLORS.high}
            />
            <SeverityBox
              label="Medium"
              count={stats?.bySeverity?.medium || 0}
              color={SEVERITY_COLORS.medium}
            />
            <SeverityBox
              label="Low"
              count={stats?.bySeverity?.low || 0}
              color={SEVERITY_COLORS.low}
            />
          </Box>
        </Box>

        {/* By Detection Type */}
        <Box>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            Detection Methods
          </Text>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: tokens.spacing[3],
            }}
          >
            <TypeBox title="Z-Score" count={stats?.byType?.z_score || 0} />
            <TypeBox title="IQR" count={stats?.byType?.iqr || 0} />
            <TypeBox title="Pattern" count={stats?.byType?.pattern || 0} />
          </Box>
        </Box>

        {/* Recent Anomalies */}
        <Box>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            Recent Detections
          </Text>
          <Box
            style={{
              maxHeight: '250px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing[2],
            }}
          >
            {!recentAnomalies || recentAnomalies.length === 0 ? (
              <Box
                style={{
                  padding: tokens.spacing[4],
                  textAlign: 'center',
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.md,
                }}
              >
                <Text size="sm" color="tertiary">
                  No recent anomalies detected
                </Text>
              </Box>
            ) : (
              recentAnomalies.map((anomaly) => {
                const severityColor = SEVERITY_COLORS[anomaly.severity as keyof typeof SEVERITY_COLORS] || tokens.colors.text.secondary
                return (
                  <Box
                    key={anomaly.id}
                    style={{
                      padding: tokens.spacing[3],
                      background: `${severityColor}10`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${severityColor}`,
                    }}
                  >
                    <Box style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing[1] }}>
                      <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
                        <Text size="sm" weight="bold" style={{ color: severityColor }}>
                          {anomaly.severity.toUpperCase()}
                        </Text>
                        <Text size="sm" color="secondary">
                          {anomaly.trader_id} • {anomaly.platform}
                        </Text>
                      </Box>
                      <Text size="xs" color="tertiary">
                        {new Date(anomaly.detected_at).toLocaleTimeString()}
                      </Text>
                    </Box>
                    <Text size="xs" color="secondary">
                      {anomaly.anomaly_type} detection on {anomaly.field_name}
                    </Text>
                  </Box>
                )
              })
            )}
          </Box>
        </Box>
      </Box>
    </Card>
  )
}

function StatBox({ title, value, color }: { title: string; value: number; color: string }) {
  return (
    <Box
      style={{
        padding: tokens.spacing[3],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
        {title}
      </Text>
      <Text size="2xl" weight="black" style={{ color }}>
        {value}
      </Text>
    </Box>
  )
}

function SeverityBox({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <Box
      style={{
        padding: tokens.spacing[3],
        background: `${color}15`,
        borderRadius: tokens.radius.md,
        border: `1px solid ${color}`,
      }}
    >
      <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
        {label}
      </Text>
      <Text size="2xl" weight="black" style={{ color }}>
        {count}
      </Text>
    </Box>
  )
}

function TypeBox({ title, count }: { title: string; count: number }) {
  return (
    <Box
      style={{
        padding: tokens.spacing[3],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
        {title}
      </Text>
      <Text size="xl" weight="bold">
        {count}
      </Text>
    </Box>
  )
}
