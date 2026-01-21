'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useReports } from '../hooks/useReports'

interface ReportsTabProps {
  accessToken: string | null
}

const REASON_LABELS: Record<string, string> = {
  spam: '垃圾内容',
  harassment: '骚扰',
  inappropriate: '不当内容',
  misinformation: '虚假信息',
  other: '其他',
}

export default function ReportsTab({ accessToken }: ReportsTabProps) {
  const {
    reports,
    pagination,
    loading,
    actionLoading,
    loadReports,
    resolveReport,
  } = useReports(accessToken)

  const [status, setStatus] = useState<'pending' | 'resolved' | 'dismissed' | 'all'>('pending')
  const [contentType, setContentType] = useState<'post' | 'comment' | 'all'>('all')

  useEffect(() => {
    if (accessToken) {
      loadReports(1, status, contentType)
    }
  }, [accessToken, loadReports, status, contentType])

  const handlePageChange = (page: number) => {
    loadReports(page, status, contentType)
  }

  return (
    <Card title="内容举报处理">
      {/* Filters */}
      <Box style={{ marginBottom: tokens.spacing[4], display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
        <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
          <Text size="sm" color="secondary">状态:</Text>
          {(['pending', 'resolved', 'dismissed', 'all'] as const).map((s) => (
            <Button
              key={s}
              variant={status === s ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setStatus(s)}
            >
              {s === 'pending' ? '待处理' : s === 'resolved' ? '已处理' : s === 'dismissed' ? '已驳回' : '全部'}
            </Button>
          ))}
        </Box>
        
        <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
          <Text size="sm" color="secondary">类型:</Text>
          {(['all', 'post', 'comment'] as const).map((t) => (
            <Button
              key={t}
              variant={contentType === t ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setContentType(t)}
            >
              {t === 'all' ? '全部' : t === 'post' ? '帖子' : '评论'}
            </Button>
          ))}
        </Box>
      </Box>

      {/* Reports List */}
      {loading ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">加载中...</Text>
        </Box>
      ) : reports.length === 0 ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">暂无举报</Text>
        </Box>
      ) : (
        <>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {reports.map((report) => (
              <Box
                key={report.id}
                style={{
                  padding: tokens.spacing[4],
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                {/* Header */}
                <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[3] }}>
                  <Box style={{ display: 'flex', gap: tokens.spacing[3], alignItems: 'center' }}>
                    <Box
                      style={{
                        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                        borderRadius: tokens.radius.sm,
                        background: report.content_type === 'post' ? tokens.colors.accent.primary : tokens.colors.accent.warning,
                        color: '#fff',
                        fontSize: tokens.typography.fontSize.xs,
                      }}
                    >
                      {report.content_type === 'post' ? '帖子' : '评论'}
                    </Box>
                    <Box
                      style={{
                        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                        borderRadius: tokens.radius.sm,
                        background: tokens.colors.bg.tertiary,
                        fontSize: tokens.typography.fontSize.xs,
                      }}
                    >
                      {REASON_LABELS[report.reason] || report.reason}
                    </Box>
                  </Box>
                  <Text size="xs" color="tertiary">
                    {new Date(report.created_at).toLocaleString('zh-CN')}
                  </Text>
                </Box>

                {/* Reporter */}
                <Box style={{ marginBottom: tokens.spacing[2] }}>
                  <Text size="sm" color="secondary">
                    举报人: @{report.reporter?.handle || '未知'}
                  </Text>
                </Box>

                {/* Content Preview */}
                {report.contentPreview && (
                  <Box
                    style={{
                      padding: tokens.spacing[3],
                      background: tokens.colors.bg.primary,
                      borderRadius: tokens.radius.md,
                      marginBottom: tokens.spacing[3],
                    }}
                  >
                    {report.contentPreview.title && (
                      <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
                        {report.contentPreview.title}
                      </Text>
                    )}
                    <Text size="sm" color="secondary">
                      {report.contentPreview.content || '(无内容)'}
                    </Text>
                    {report.contentAuthor && (
                      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
                        作者: @{report.contentAuthor.handle || '未知'}
                      </Text>
                    )}
                  </Box>
                )}

                {/* Description */}
                {report.description && (
                  <Box style={{ marginBottom: tokens.spacing[3] }}>
                    <Text size="xs" color="tertiary">举报说明:</Text>
                    <Text size="sm" color="secondary">{report.description}</Text>
                  </Box>
                )}

                {/* Actions */}
                {report.status === 'pending' && (
                  <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => resolveReport(report.id, 'resolve')}
                      disabled={actionLoading[report.id]}
                      style={{ background: tokens.colors.accent.error }}
                    >
                      {actionLoading[report.id] ? '处理中...' : '删除内容'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => resolveReport(report.id, 'dismiss')}
                      disabled={actionLoading[report.id]}
                    >
                      驳回举报
                    </Button>
                  </Box>
                )}

                {/* Resolved Info */}
                {report.status !== 'pending' && (
                  <Box
                    style={{
                      padding: tokens.spacing[2],
                      background: report.status === 'resolved' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(156, 163, 175, 0.1)',
                      borderRadius: tokens.radius.sm,
                    }}
                  >
                    <Text size="xs" color="tertiary">
                      {report.status === 'resolved' ? '已处理: 内容已删除' : '已驳回'}
                      {report.action_taken && ` - ${report.action_taken}`}
                    </Text>
                  </Box>
                )}
              </Box>
            ))}
          </Box>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <Box style={{ marginTop: tokens.spacing[4], display: 'flex', justifyContent: 'center', gap: tokens.spacing[2] }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handlePageChange(pagination.page - 1)}
                disabled={pagination.page <= 1}
              >
                上一页
              </Button>
              <Text size="sm" color="secondary" style={{ display: 'flex', alignItems: 'center' }}>
                {pagination.page} / {pagination.totalPages}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handlePageChange(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
              >
                下一页
              </Button>
            </Box>
          )}
        </>
      )}
    </Card>
  )
}
