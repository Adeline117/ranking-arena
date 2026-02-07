'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Card from '@/app/components/ui/Card'

interface SystemMetricsProps {
  data: {
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
}

export default function SystemMetrics({ data }: SystemMetricsProps) {
  if (data.error) {
    return (
      <Card title="System Metrics">
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">
            {data.error}
          </Text>
        </Box>
      </Card>
    )
  }

  const getChangeIndicator = (today: number, yesterday: number) => {
    if (today > yesterday) return { text: `+${today - yesterday}`, color: tokens.colors.accent.success }
    if (today < yesterday) return { text: `${today - yesterday}`, color: tokens.colors.accent.error }
    return { text: '0', color: tokens.colors.text.tertiary }
  }

  return (
    <Card title="System Health & Activity">
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {/* User Metrics */}
        {data.users && (
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              User Activity
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: tokens.spacing[3],
              }}
            >
              <MetricCard title="Total Users" value={data.users.total.toLocaleString()} />
              <MetricCard
                title="New Today"
                value={data.users.newToday}
                subtitle={`${getChangeIndicator(data.users.newToday, data.users.newYesterday).text} vs yesterday`}
                color={getChangeIndicator(data.users.newToday, data.users.newYesterday).color}
              />
              <MetricCard title="New Yesterday" value={data.users.newYesterday} />
              <MetricCard
                title="Banned"
                value={data.users.banned}
                color={data.users.banned > 0 ? tokens.colors.accent.error : tokens.colors.text.secondary}
              />
            </Box>
          </Box>
        )}

        {/* Content Metrics */}
        {data.content && (
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              Content Activity
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: tokens.spacing[3],
              }}
            >
              <MetricCard title="Total Posts" value={data.content.posts.total.toLocaleString()} />
              <MetricCard
                title="New Posts Today"
                value={data.content.posts.newToday}
                subtitle={`${getChangeIndicator(data.content.posts.newToday, data.content.posts.newYesterday).text} vs yesterday`}
                color={getChangeIndicator(data.content.posts.newToday, data.content.posts.newYesterday).color}
              />
              <MetricCard title="Total Comments" value={data.content.comments.total.toLocaleString()} />
              <MetricCard
                title="New Comments Today"
                value={data.content.comments.newToday}
                color={data.content.comments.newToday > 0 ? tokens.colors.accent.success : tokens.colors.text.secondary}
              />
            </Box>
          </Box>
        )}

        {/* Moderation Metrics */}
        {data.moderation && (
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              Moderation Queue
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: tokens.spacing[3],
              }}
            >
              <MetricCard
                title="Pending Reports"
                value={data.moderation.reports.pending}
                color={data.moderation.reports.pending > 0 ? tokens.colors.accent.warning : tokens.colors.accent.success}
              />
              <MetricCard title="Reports This Week" value={data.moderation.reports.thisWeek} />
              <MetricCard title="Total Groups" value={data.moderation.groups.total} />
              <MetricCard
                title="Pending Applications"
                value={data.moderation.groups.pendingApplications}
                color={
                  data.moderation.groups.pendingApplications > 0
                    ? tokens.colors.accent.warning
                    : tokens.colors.text.secondary
                }
              />
            </Box>
          </Box>
        )}

        {/* Scraper Health */}
        {data.scraperHealth && (
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              Data Scraper Status
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: tokens.spacing[3],
              }}
            >
              <HealthCard
                title="Fresh (<12h)"
                value={data.scraperHealth.fresh}
                color={tokens.colors.accent.success}
                icon="OK"
              />
              <HealthCard
                title="Stale (12-24h)"
                value={data.scraperHealth.stale}
                color={tokens.colors.accent.warning}
                icon="WARN"
              />
              <HealthCard
                title="Critical (>24h)"
                value={data.scraperHealth.critical}
                color={tokens.colors.accent.error}
                icon="ERR"
              />
            </Box>
          </Box>
        )}
      </Box>
    </Card>
  )
}

function MetricCard({
  title,
  value,
  subtitle,
  color,
}: {
  title: string
  value: string | number
  subtitle?: string
  color?: string
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
      <Text size="xl" weight="bold" style={{ color: color || tokens.colors.text.primary }}>
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

function HealthCard({
  title,
  value,
  color,
  icon,
}: {
  title: string
  value: number
  color: string
  icon: string
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
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[1] }}>
        <Text size="xs" color="tertiary">
          {title}
        </Text>
        <Text size="md">{icon}</Text>
      </Box>
      <Text size="2xl" weight="black" style={{ color }}>
        {value}
      </Text>
    </Box>
  )
}
