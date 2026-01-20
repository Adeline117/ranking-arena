'use client'

import { useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/Base'
import Card from '@/app/components/UI/Card'
import { useStats, AdminStats } from '../hooks/useStats'

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

  useEffect(() => {
    if (accessToken) {
      loadStats()
    }
  }, [accessToken, loadStats])

  const getChangeText = (today: number, yesterday: number) => {
    const diff = today - yesterday
    if (diff > 0) return `+${diff} 较昨日`
    if (diff < 0) return `${diff} 较昨日`
    return '与昨日持平'
  }

  return (
    <Card title="数据仪表盘">
      <Box style={{ marginBottom: tokens.spacing[4], textAlign: 'right' }}>
        <Button variant="secondary" size="sm" onClick={loadStats} disabled={loading}>
          {loading ? '刷新中...' : '刷新数据'}
        </Button>
      </Box>

      {loading && !stats ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">加载中...</Text>
        </Box>
      ) : stats ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
          {/* 用户统计 */}
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              用户统计
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: tokens.spacing[3],
              }}
            >
              <StatCard title="总用户数" value={stats.users.total.toLocaleString()} />
              <StatCard
                title="今日新增"
                value={stats.users.newToday}
                subtitle={getChangeText(stats.users.newToday, stats.users.newYesterday)}
                color={stats.users.newToday > 0 ? tokens.colors.accent.success : undefined}
              />
              <StatCard
                title="封禁用户"
                value={stats.users.banned}
                color={stats.users.banned > 0 ? tokens.colors.accent.error : undefined}
              />
            </Box>
          </Box>

          {/* 内容统计 */}
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              内容统计
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: tokens.spacing[3],
              }}
            >
              <StatCard title="总帖子数" value={stats.posts.total.toLocaleString()} />
              <StatCard
                title="今日新帖"
                value={stats.posts.newToday}
                subtitle={getChangeText(stats.posts.newToday, stats.posts.newYesterday)}
                color={stats.posts.newToday > 0 ? tokens.colors.accent.success : undefined}
              />
              <StatCard title="总评论数" value={stats.comments.total.toLocaleString()} />
              <StatCard
                title="今日新评论"
                value={stats.comments.newToday}
                color={stats.comments.newToday > 0 ? tokens.colors.accent.success : undefined}
              />
            </Box>
          </Box>

          {/* 审核统计 */}
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              审核统计
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: tokens.spacing[3],
              }}
            >
              <StatCard
                title="待处理举报"
                value={stats.reports.pending}
                color={stats.reports.pending > 0 ? tokens.colors.accent.warning : tokens.colors.accent.success}
              />
              <StatCard title="本周举报" value={stats.reports.thisWeek} />
              <StatCard title="总小组数" value={stats.groups.total} />
              <StatCard
                title="待审核小组申请"
                value={stats.groups.pendingApplications}
                color={stats.groups.pendingApplications > 0 ? tokens.colors.accent.warning : undefined}
              />
            </Box>
          </Box>

          {/* 爬虫健康 */}
          <Box>
            <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              爬虫健康状态
            </Text>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: tokens.spacing[3],
              }}
            >
              <StatCard
                title="正常"
                value={stats.scraperHealth.fresh}
                color={tokens.colors.accent.success}
              />
              <StatCard
                title="陈旧 (>12h)"
                value={stats.scraperHealth.stale}
                color={stats.scraperHealth.stale > 0 ? tokens.colors.accent.warning : tokens.colors.accent.success}
              />
              <StatCard
                title="严重 (>24h)"
                value={stats.scraperHealth.critical}
                color={stats.scraperHealth.critical > 0 ? tokens.colors.accent.error : tokens.colors.accent.success}
              />
            </Box>
          </Box>
        </Box>
      ) : (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">暂无数据</Text>
        </Box>
      )}
    </Card>
  )
}
