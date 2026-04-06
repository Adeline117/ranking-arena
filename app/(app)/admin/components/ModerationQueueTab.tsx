'use client'

import { useEffect, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'

interface ModerationQueueTabProps {
  accessToken: string | null
}

interface ReportItem {
  id: string
  reporter_id: string
  reason: string
  description: string | null
  created_at: string
  reporter_handle: string | null
}

interface QueueItem {
  content_type: 'post' | 'comment'
  content_id: string
  content_preview: string | null
  content_title: string | null
  author_id: string | null
  author_handle: string | null
  reports: ReportItem[]
  report_count: number
}

const PAGE_SIZE = 20

export default function ModerationQueueTab({ accessToken }: ModerationQueueTabProps) {
  const { t } = useLanguage()
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [expandedContent, setExpandedContent] = useState<Record<string, boolean>>({})

  const loadQueue = useCallback(async (pageNum: number = 1) => {
    if (!accessToken) return

    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(pageNum),
        limit: String(PAGE_SIZE),
      })

      const res = await fetch(`/api/admin/moderation-queue?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()

      if (data.success) {
        setQueue(data.data.items)
        setTotalPages(Math.ceil((data.data.total || 0) / PAGE_SIZE) || 1)
        setPage(pageNum)
      }
    } catch (err) {
      logger.error('Error loading moderation queue:', err)
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    if (accessToken) {
      loadQueue(1)
    }
  }, [accessToken, loadQueue])

  const handleAction = async (
    contentType: string,
    contentId: string,
    action: 'approve' | 'delete' | 'warn' | 'ban',
    authorId?: string | null
  ) => {
    if (!accessToken) return

    const key = `${contentType}-${contentId}`
    setActionLoading((prev) => ({ ...prev, [key]: true }))

    try {
      const res = await fetch('/api/admin/moderation-queue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          content_type: contentType,
          content_id: contentId,
          action,
          author_id: authorId,
        }),
      })

      const data = await res.json()
      if (data.success) {
        // Remove from queue
        setQueue((prev) =>
          prev.filter((item) => !(item.content_type === contentType && item.content_id === contentId))
        )
      }
    } catch (err) {
      logger.error('Error performing moderation action:', err)
    } finally {
      setActionLoading((prev) => ({ ...prev, [key]: false }))
    }
  }

  const toggleExpand = (key: string) => {
    setExpandedContent((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <Card title={t('moderationQueue') || 'Moderation Queue'}>
      {loading ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : queue.length === 0 ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">No items pending moderation</Text>
        </Box>
      ) : (
        <>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {queue.map((item) => {
              const key = `${item.content_type}-${item.content_id}`
              const isExpanded = expandedContent[key]
              const isActing = actionLoading[key]

              return (
                <Box
                  key={key}
                  style={{
                    padding: tokens.spacing[4],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.lg,
                    border: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  {/* Header */}
                  <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[3] }}>
                    <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
                      <Box
                        style={{
                          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                          borderRadius: tokens.radius.sm,
                          background: item.content_type === 'post' ? tokens.colors.accent.primary : tokens.colors.accent.warning,
                          color: tokens.colors.white,
                          fontSize: tokens.typography.fontSize.xs,
                        }}
                      >
                        {item.content_type}
                      </Box>
                      <Box
                        style={{
                          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                          borderRadius: tokens.radius.sm,
                          background: item.report_count >= 5 ? tokens.colors.accent.error : tokens.colors.bg.tertiary,
                          color: item.report_count >= 5 ? tokens.colors.white : tokens.colors.text.primary,
                          fontSize: tokens.typography.fontSize.xs,
                        }}
                      >
                        {item.report_count} report{item.report_count !== 1 ? 's' : ''}
                      </Box>
                    </Box>
                    {item.author_handle && (
                      <Text size="sm" color="secondary">
                        by @{item.author_handle}
                      </Text>
                    )}
                  </Box>

                  {/* Content Preview */}
                  <Box
                    style={{
                      padding: tokens.spacing[3],
                      background: tokens.colors.bg.primary,
                      borderRadius: tokens.radius.md,
                      marginBottom: tokens.spacing[3],
                    }}
                  >
                    {item.content_title && (
                      <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
                        {item.content_title}
                      </Text>
                    )}
                    <Text size="sm" color="secondary">
                      {item.content_preview || '(no content)'}
                    </Text>
                  </Box>

                  {/* Reports toggle */}
                  <Button
                    variant="text"
                    size="sm"
                    onClick={() => toggleExpand(key)}
                    style={{ marginBottom: tokens.spacing[2] }}
                  >
                    {isExpanded ? 'Hide reports' : `Show ${item.report_count} report${item.report_count !== 1 ? 's' : ''}`}
                  </Button>

                  {/* Individual reports */}
                  {isExpanded && (
                    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
                      {item.reports.map((report) => (
                        <Box
                          key={report.id}
                          style={{
                            padding: tokens.spacing[2],
                            background: tokens.colors.bg.tertiary,
                            borderRadius: tokens.radius.sm,
                          }}
                        >
                          <Box style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <Text size="xs" color="secondary">
                              @{report.reporter_handle || 'anonymous'} - {report.reason}
                            </Text>
                            <Text size="xs" color="tertiary">
                              {new Date(report.created_at).toLocaleString()}
                            </Text>
                          </Box>
                          {report.description && (
                            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                              {report.description}
                            </Text>
                          )}
                        </Box>
                      ))}
                    </Box>
                  )}

                  {/* Actions */}
                  <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleAction(item.content_type, item.content_id, 'approve')}
                      disabled={isActing}
                    >
                      {isActing ? t('processing') : 'Approve (Dismiss)'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleAction(item.content_type, item.content_id, 'delete')}
                      disabled={isActing}
                      style={{ background: tokens.colors.accent.error, color: tokens.colors.white }}
                    >
                      Delete Content
                    </Button>
                    {item.author_id && (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleAction(item.content_type, item.content_id, 'warn', item.author_id)}
                          disabled={isActing}
                          style={{ background: tokens.colors.accent.warning, color: tokens.colors.white }}
                        >
                          Warn User
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleAction(item.content_type, item.content_id, 'ban', item.author_id)}
                          disabled={isActing}
                          style={{ background: tokens.colors.accent.error, color: tokens.colors.white }}
                        >
                          Ban User
                        </Button>
                      </>
                    )}
                  </Box>
                </Box>
              )
            })}
          </Box>

          {/* Pagination */}
          {totalPages > 1 && (
            <Box style={{ marginTop: tokens.spacing[4], display: 'flex', justifyContent: 'center', gap: tokens.spacing[2] }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => loadQueue(page - 1)}
                disabled={page <= 1}
              >
                {t('prevPage')}
              </Button>
              <Text size="sm" color="secondary" style={{ display: 'flex', alignItems: 'center' }}>
                {page} / {totalPages}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => loadQueue(page + 1)}
                disabled={page >= totalPages}
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
