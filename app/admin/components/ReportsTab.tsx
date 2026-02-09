'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useReports } from '../hooks/useReports'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface ReportsTabProps {
  accessToken: string | null
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
  const { t } = useLanguage()

  const REASON_LABELS: Record<string, string> = {
    spam: t('adminReasonSpam'),
    harassment: t('adminReasonHarassment'),
    inappropriate: t('adminReasonInappropriate'),
    misinformation: t('adminReasonMisinformation'),
    fraud: t('adminReasonFraud'),
    other: t('adminReasonOther'),
  }

  const CONTENT_TYPE_LABELS: Record<string, string> = {
    post: t('adminContentPost'),
    comment: t('adminContentComment'),
    message: t('adminContentMessage'),
    user: t('adminContentUser'),
  }

  const [status, setStatus] = useState<'pending' | 'resolved' | 'dismissed' | 'all'>('pending')
  const [contentType, setContentType] = useState<'post' | 'comment' | 'message' | 'user' | 'all'>('all')

  useEffect(() => {
    if (accessToken) {
      loadReports(1, status, contentType)
    }
  }, [accessToken, loadReports, status, contentType])

  const handlePageChange = (page: number) => {
    loadReports(page, status, contentType)
  }

  return (
    <Card title={t('adminReportHandling')}>
      {/* Filters */}
      <Box style={{ marginBottom: tokens.spacing[4], display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
        <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
          <Text size="sm" color="secondary">{t('adminStatusFilter')}</Text>
          {(['pending', 'resolved', 'dismissed', 'all'] as const).map((s) => (
            <Button
              key={s}
              variant={status === s ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setStatus(s)}
            >
              {s === 'pending' ? t('adminPending') : s === 'resolved' ? t('adminResolved') : s === 'dismissed' ? t('adminDismissed') : t('adminFilterAll')}
            </Button>
          ))}
        </Box>

        <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center', flexWrap: 'wrap' }}>
          <Text size="sm" color="secondary">{t('adminTypeFilter')}</Text>
          {(['all', 'post', 'comment', 'message', 'user'] as const).map((ct) => (
            <Button
              key={ct}
              variant={contentType === ct ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setContentType(ct)}
            >
              {ct === 'all' ? t('adminFilterAll') : CONTENT_TYPE_LABELS[ct] || ct}
            </Button>
          ))}
        </Box>
      </Box>

      {/* Reports List */}
      {loading ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : reports.length === 0 ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('adminNoReports')}</Text>
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
                        background: report.content_type === 'post'
                          ? tokens.colors.accent.primary
                          : report.content_type === 'message'
                            ? 'var(--color-brand)'
                            : report.content_type === 'user'
                              ? 'var(--color-accent-error)'
                              : tokens.colors.accent.warning,
                        color: tokens.colors.white,
                        fontSize: tokens.typography.fontSize.xs,
                      }}
                    >
                      {CONTENT_TYPE_LABELS[report.content_type] || report.content_type}
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
                    {new Date(report.created_at).toLocaleString()}
                  </Text>
                </Box>

                {/* Reporter */}
                <Box style={{ marginBottom: tokens.spacing[2] }}>
                  <Text size="sm" color="secondary">
                    {t('adminReporter').replace('{handle}', report.reporter?.handle || t('unknown'))}
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
                      {report.contentPreview.content || t('adminNoContent')}
                    </Text>
                    {report.contentAuthor && (
                      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
                        {t('adminAuthor').replace('{handle}', report.contentAuthor.handle || t('unknown'))}
                      </Text>
                    )}
                  </Box>
                )}

                {/* Description */}
                {report.description && (
                  <Box style={{ marginBottom: tokens.spacing[3] }}>
                    <Text size="xs" color="tertiary">{t('adminReportDesc')}</Text>
                    <Text size="sm" color="secondary">{report.description}</Text>
                  </Box>
                )}

                {/* Evidence Images */}
                {report.images && report.images.length > 0 && (
                  <Box style={{ marginBottom: tokens.spacing[3] }}>
                    <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                      {t('adminReportEvidence') || '截图证据'} ({report.images.length})
                    </Text>
                    <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                      {report.images.map((img: string, i: number) => (
                        <a key={i} href={img} target="_blank" rel="noopener noreferrer" style={{ display: 'block' }}>
                          <img
                            src={img}
                            alt={`Evidence ${i + 1}`}
                            width={120}
                            height={90}
                            loading="lazy"
                            style={{
                              width: 120, height: 90, objectFit: 'cover',
                              borderRadius: tokens.radius.md,
                              border: `1px solid ${tokens.colors.border.primary}`,
                              cursor: 'pointer',
                            }}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        </a>
                      ))}
                    </Box>
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
                      {actionLoading[report.id] ? t('processing') : t('adminDeleteContent')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => resolveReport(report.id, 'dismiss')}
                      disabled={actionLoading[report.id]}
                    >
                      {t('adminDismissReport')}
                    </Button>
                  </Box>
                )}

                {/* Resolved Info */}
                {report.status !== 'pending' && (
                  <Box
                    style={{
                      padding: tokens.spacing[2],
                      background: report.status === 'resolved' ? 'var(--color-accent-error-10)' : 'var(--color-overlay-subtle)',
                      borderRadius: tokens.radius.sm,
                    }}
                  >
                    <Text size="xs" color="tertiary">
                      {report.status === 'resolved' ? t('adminResolvedDeleted') : t('adminDismissedStatus')}
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
                {t('prevPage')}
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
                {t('nextPage')}
              </Button>
            </Box>
          )}
        </>
      )}
    </Card>
  )
}
