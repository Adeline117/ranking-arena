'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Card from '@/app/components/ui/Card'

interface TierInfo {
  count: number
  percentage: string
  refreshInterval: string
}

interface TierDistribution {
  hot?: TierInfo
  active?: TierInfo
  normal?: TierInfo
  dormant?: TierInfo
}

interface ApiEfficiency {
  currentSystem?: { callsPerDay: number }
  smartScheduler?: { callsPerDay: number }
  reduction?: { percentage: string; callsSaved: number }
  costSavings?: { perDay: string; perMonth: string; perYear: string }
}

interface DataFreshness {
  overdueTraders: number
  lastTierUpdate?: string
}

interface SchedulerMetricsProps {
  data: {
    enabled: boolean
    tierDistribution?: TierDistribution
    apiEfficiency?: ApiEfficiency
    dataFreshness?: DataFreshness
    error?: string
  }
}

export default function SchedulerMetrics({ data }: SchedulerMetricsProps) {
  if (!data.enabled) {
    return (
      <Card title="Smart Scheduler">
        <Box
          style={{
            padding: tokens.spacing[6],
            textAlign: 'center',
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.md,
          }}
        >
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
            Smart Scheduler is currently disabled
          </Text>
          <Text size="xs" color="tertiary">
            Set ENABLE_SMART_SCHEDULER=true to enable tier-based refresh scheduling
          </Text>
        </Box>
      </Card>
    )
  }

  if (data.error) {
    return (
      <Card title="Smart Scheduler">
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">
            {data.error}
          </Text>
        </Box>
      </Card>
    )
  }

  const { tierDistribution, apiEfficiency, dataFreshness } = data

  return (
    <Card title="Smart Scheduler Performance">
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {/* Tier Distribution */}
        <Box>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            Tier Distribution
          </Text>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: tokens.spacing[3],
            }}
          >
            <TierCard
              name="Hot"
              count={tierDistribution?.hot?.count || 0}
              percentage={tierDistribution?.hot?.percentage || '0%'}
              interval={tierDistribution?.hot?.refreshInterval || 'N/A'}
              color="var(--color-accent-error)"
            />
            <TierCard
              name="Active"
              count={tierDistribution?.active?.count || 0}
              percentage={tierDistribution?.active?.percentage || '0%'}
              interval={tierDistribution?.active?.refreshInterval || 'N/A'}
              color="var(--color-medal-gold)"
            />
            <TierCard
              name="Normal"
              count={tierDistribution?.normal?.count || 0}
              percentage={tierDistribution?.normal?.percentage || '0%'}
              interval={tierDistribution?.normal?.refreshInterval || 'N/A'}
              color="var(--color-chart-green)"
            />
            <TierCard
              name="Dormant"
              count={tierDistribution?.dormant?.count || 0}
              percentage={tierDistribution?.dormant?.percentage || '0%'}
              interval={tierDistribution?.dormant?.refreshInterval || 'N/A'}
              color="var(--color-text-secondary)"
            />
          </Box>
        </Box>

        {/* API Efficiency */}
        <Box>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            API Call Efficiency
          </Text>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: tokens.spacing[3],
            }}
          >
            <MetricCard
              title="Current System"
              value={apiEfficiency?.currentSystem?.callsPerDay?.toLocaleString() || 'N/A'}
              subtitle="calls/day"
              color={tokens.colors.text.secondary}
            />
            <MetricCard
              title="Smart Scheduler"
              value={apiEfficiency?.smartScheduler?.callsPerDay?.toLocaleString() || 'N/A'}
              subtitle="calls/day"
              color="var(--color-chart-green)"
            />
            <MetricCard
              title="Reduction"
              value={apiEfficiency?.reduction?.percentage || 'N/A'}
              subtitle={`${apiEfficiency?.reduction?.callsSaved?.toLocaleString() || 0} calls saved`}
              color="var(--color-chart-green)"
            />
          </Box>
        </Box>

        {/* Cost Savings */}
        <Box>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            Cost Savings
          </Text>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: tokens.spacing[3],
            }}
          >
            <MetricCard
              title="Per Day"
              value={apiEfficiency?.costSavings?.perDay || 'N/A'}
              color="var(--color-chart-green)"
            />
            <MetricCard
              title="Per Month"
              value={apiEfficiency?.costSavings?.perMonth || 'N/A'}
              color="var(--color-chart-green)"
            />
            <MetricCard
              title="Per Year"
              value={apiEfficiency?.costSavings?.perYear || 'N/A'}
              color="var(--color-chart-green)"
            />
          </Box>
        </Box>

        {/* Data Freshness */}
        <Box>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            Data Freshness
          </Text>
          <Box
            style={{
              padding: tokens.spacing[3],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Box style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing[2] }}>
              <Text size="sm" color="secondary">
                Overdue Traders
              </Text>
              <Text size="sm" weight="bold" style={{ color: (dataFreshness?.overdueTraders ?? 0) > 0 ? 'var(--color-medal-gold)' : 'var(--color-chart-green)' }}>
                {dataFreshness?.overdueTraders || 0}
              </Text>
            </Box>
            {dataFreshness?.lastTierUpdate && (
              <Box style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Text size="sm" color="secondary">
                  Last Tier Update
                </Text>
                <Text size="sm" color="secondary">
                  {new Date(dataFreshness.lastTierUpdate).toLocaleString()}
                </Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Card>
  )
}

function TierCard({
  name,
  count,
  percentage,
  interval,
  color,
}: {
  name: string
  count: number
  percentage: string
  interval: string
  color: string
}) {
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
        {name}
      </Text>
      <Text size="2xl" weight="black" style={{ color }}>
        {count}
      </Text>
      <Text size="xs" color="secondary" style={{ marginTop: tokens.spacing[1] }}>
        {percentage} • {interval}
      </Text>
    </Box>
  )
}

function MetricCard({
  title,
  value,
  subtitle,
  color,
}: {
  title: string
  value: string
  subtitle?: string
  color: string
}) {
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
      <Text size="xl" weight="bold" style={{ color }}>
        {value}
      </Text>
      {subtitle && (
        <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
          {subtitle}
        </Text>
      )}
    </Box>
  )
}
