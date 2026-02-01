'use client'

import { useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useStats } from '../hooks/useStats'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface DashboardTabProps {
  accessToken: string | null
}

function StatCard({
  title,
  value,
  subtitle,
  color = tokens.colors.text.primary,
}: {
  title: string
  value: string | number
  subtitle?: string
  color?: string
}) {
  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
        {title}
      </Text>
      <Text size="2xl" weight="black" style={{ color }}>
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

export default function DashboardTab({ accessToken }: DashboardTabProps) {
  const { stats, loading, loadStats } = useStats(accessToken)
  const { t } = useLanguage()

  useEffect(() => {
    if (accessToken) {
      loadStats()
    }
  }, [accessToken, loadStats])

  const getChangeText = (today: number, yesterday: number) => {
    const diff = today - yesterday
    if (diff > 0) return t('adminVsYesterdayUp').replace('{diff}', String(diff))
    if (diff < 0) return t('adminVsYesterdayDown').replace('{diff}', String(diff))
    return t('adminSameAsYesterday')
  }

  return (
    <Card title={t('adminDataDashboard')}>
      <Box style={{ marginBottom: tokens.spacing[4], textAlign: 'right' }}>
        <Button variant="secondary" size="sm" onClick={loadStats} disabled={loading}>
          {loading ? t('adminRefreshing') : t('adminRefreshData')}
        </Button>
      </Box>

      {loading && !stats ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : stats ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
          {/* User Stats */}
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              {t('adminUserStats')}
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: tokens.spacing[3],
              }}
            >
              <StatCard title={t('adminTotalUsers')} value={stats.users.total.toLocaleString()} />
              <StatCard
                title={t('adminNewToday')}
                value={stats.users.newToday}
                subtitle={getChangeText(stats.users.newToday, stats.users.newYesterday)}
                color={stats.users.newToday > 0 ? tokens.colors.accent.success : undefined}
              />
              <StatCard
                title={t('adminBannedUsers')}
                value={stats.users.banned}
                color={stats.users.banned > 0 ? tokens.colors.accent.error : undefined}
              />
            </Box>
          </Box>

          {/* Content Stats */}
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              {t('adminContentStats')}
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: tokens.spacing[3],
              }}
            >
              <StatCard title={t('adminTotalPosts')} value={stats.posts.total.toLocaleString()} />
              <StatCard
                title={t('adminNewPostsToday')}
                value={stats.posts.newToday}
                subtitle={getChangeText(stats.posts.newToday, stats.posts.newYesterday)}
                color={stats.posts.newToday > 0 ? tokens.colors.accent.success : undefined}
              />
              <StatCard title={t('adminTotalComments')} value={stats.comments.total.toLocaleString()} />
              <StatCard
                title={t('adminNewCommentsToday')}
                value={stats.comments.newToday}
                color={stats.comments.newToday > 0 ? tokens.colors.accent.success : undefined}
              />
            </Box>
          </Box>

          {/* Moderation Stats */}
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              {t('adminModerationStats')}
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: tokens.spacing[3],
              }}
            >
              <StatCard
                title={t('adminPendingReports')}
                value={stats.reports.pending}
                color={stats.reports.pending > 0 ? tokens.colors.accent.warning : tokens.colors.accent.success}
              />
              <StatCard title={t('adminReportsThisWeek')} value={stats.reports.thisWeek} />
              <StatCard title={t('adminTotalGroups')} value={stats.groups.total} />
              <StatCard
                title={t('adminPendingGroupApps')}
                value={stats.groups.pendingApplications}
                color={stats.groups.pendingApplications > 0 ? tokens.colors.accent.warning : undefined}
              />
            </Box>
          </Box>

          {/* Scraper Health */}
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              {t('adminScraperHealth')}
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: tokens.spacing[3],
              }}
            >
              <StatCard
                title={t('adminScraperFresh')}
                value={stats.scraperHealth.fresh}
                color={tokens.colors.accent.success}
              />
              <StatCard
                title={t('adminScraperStale')}
                value={stats.scraperHealth.stale}
                color={stats.scraperHealth.stale > 0 ? tokens.colors.accent.warning : tokens.colors.accent.success}
              />
              <StatCard
                title={t('adminScraperCritical')}
                value={stats.scraperHealth.critical}
                color={stats.scraperHealth.critical > 0 ? tokens.colors.accent.error : tokens.colors.accent.success}
              />
            </Box>
          </Box>
        </Box>
      ) : (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('noData')}</Text>
        </Box>
      )}
    </Card>
  )
}
