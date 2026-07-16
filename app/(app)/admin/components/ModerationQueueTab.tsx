'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
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
type ModerationAction = 'approve' | 'delete' | 'warn' | 'ban'
type ModerationContentType = 'post' | 'comment'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACK_ENVELOPE_KEYS = ['data', 'meta', 'success'] as const
const ACK_DATA_KEYS = ['message', 'result'] as const
const ACK_META_KEYS = ['timestamp'] as const
const ACK_RESULT_KEYS = [
  'action_taken',
  'applied',
  'author_id',
  'content_affected_count',
  'content_soft_deleted',
  'report_count',
  'report_status',
  'result_action',
  'result_content_id',
  'result_content_type',
  'result_operation_id',
  'strike_id',
  'strike_type',
] as const

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort()
  return actualKeys.length === keys.length && keys.every((key, index) => actualKeys[index] === key)
}

function isBoundModerationAcknowledgement(
  value: unknown,
  expected: {
    action: ModerationAction
    contentType: ModerationContentType
    contentId: string
    operationId: string
  }
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!hasExactKeys(envelope, ACK_ENVELOPE_KEYS) || envelope.success !== true) return false

  if (!envelope.meta || typeof envelope.meta !== 'object' || Array.isArray(envelope.meta)) {
    return false
  }
  const meta = envelope.meta as Record<string, unknown>
  if (
    !hasExactKeys(meta, ACK_META_KEYS) ||
    typeof meta.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(meta.timestamp))
  ) {
    return false
  }

  if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
    return false
  }
  const data = envelope.data as Record<string, unknown>
  if (!hasExactKeys(data, ACK_DATA_KEYS) || typeof data.message !== 'string') return false
  if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) return false

  const result = data.result as Record<string, unknown>
  const expectedStatus = expected.action === 'approve' ? 'dismissed' : 'resolved'
  const validEffect =
    expected.action === 'approve'
      ? result.action_taken === 'approved_content'
      : expected.action === 'delete'
        ? ['content_deleted', 'content_already_absent'].includes(result.action_taken as string)
        : expected.action === 'warn'
          ? result.action_taken === 'user_warned'
          : result.action_taken === 'user_banned'

  if (
    !hasExactKeys(result, ACK_RESULT_KEYS) ||
    typeof result.applied !== 'boolean' ||
    result.result_operation_id !== expected.operationId ||
    result.result_action !== expected.action ||
    result.result_content_type !== expected.contentType ||
    result.result_content_id !== expected.contentId ||
    result.report_status !== expectedStatus ||
    !Number.isSafeInteger(result.report_count) ||
    (result.report_count as number) < 1 ||
    !validEffect ||
    !Number.isSafeInteger(result.content_affected_count) ||
    (result.content_affected_count as number) < 0 ||
    ![true, false, null].includes(result.content_soft_deleted as boolean | null) ||
    (result.author_id !== null &&
      (typeof result.author_id !== 'string' || !UUID_PATTERN.test(result.author_id))) ||
    (result.strike_id !== null &&
      (typeof result.strike_id !== 'string' || !UUID_PATTERN.test(result.strike_id))) ||
    !['warning', 'mute', 'temp_ban', 'perm_ban', null].includes(result.strike_type as string | null)
  ) {
    return false
  }

  if (!result.applied) {
    return (
      result.content_affected_count === 0 &&
      result.strike_id === null &&
      result.strike_type === null
    )
  }

  const validDeleteEffect =
    expected.action !== 'delete' ||
    (result.action_taken === 'content_deleted'
      ? result.content_soft_deleted === true && (result.content_affected_count as number) > 0
      : result.content_affected_count === 0 &&
        (result.content_soft_deleted === null
          ? result.author_id === null
          : result.content_soft_deleted === true && result.author_id !== null))

  return (
    validDeleteEffect &&
    (!['approve', 'warn'].includes(expected.action) || result.content_affected_count === 0) &&
    (!['warn', 'ban'].includes(expected.action) || result.author_id !== null) &&
    (expected.action !== 'ban' ||
      (result.content_soft_deleted === true && (result.content_affected_count as number) > 0)) &&
    (expected.action === 'warn'
      ? result.strike_id !== null && result.strike_type !== null
      : result.strike_id === null && result.strike_type === null)
  )
}

export default function ModerationQueueTab({ accessToken }: ModerationQueueTabProps) {
  const { t } = useLanguage()
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [expandedContent, setExpandedContent] = useState<Record<string, boolean>>({})
  const operationByTarget = useRef(
    new Map<string, { action: ModerationAction; operationId: string }>()
  )

  useEffect(() => {
    operationByTarget.current.clear()
  }, [accessToken])

  const loadQueue = useCallback(
    async (pageNum: number = 1, options: { silent?: boolean } = {}) => {
      if (!accessToken) return

      const silent = options.silent === true
      if (!silent) setLoading(true)
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
        if (!silent) setLoading(false)
      }
    },
    [accessToken]
  )

  useEffect(() => {
    if (accessToken) {
      loadQueue(1)
    }
  }, [accessToken, loadQueue])

  const handleAction = async (
    contentType: ModerationContentType,
    contentId: string,
    action: ModerationAction
  ) => {
    if (!accessToken) return

    const canonicalContentId = contentId.toLowerCase()
    const key = `${contentType}-${canonicalContentId}`
    let operationId: string | null = null
    let clearOperation = false
    setActionLoading((prev) => ({ ...prev, [key]: true }))

    try {
      const existingOperation = operationByTarget.current.get(key)
      operationId =
        existingOperation?.action === action ? existingOperation.operationId : crypto.randomUUID()
      if (existingOperation?.action !== action) {
        operationByTarget.current.set(key, { action, operationId })
      }

      const res = await fetch('/api/admin/moderation-queue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          content_type: contentType,
          content_id: canonicalContentId,
          action,
          operation_id: operationId,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        // A parsed explicit client/conflict response is deterministic. Server
        // failures remain uncertain even when their error body parses.
        clearOperation = res.status < 500
        return
      }

      if (
        !isBoundModerationAcknowledgement(data, {
          action,
          contentType,
          contentId: canonicalContentId,
          operationId,
        })
      ) {
        logger.error('Invalid moderation acknowledgement')
        return
      }

      clearOperation = true
      // Remove from queue
      setQueue((prev) =>
        prev.filter(
          (item) =>
            !(
              item.content_type === contentType &&
              item.content_id.toLowerCase() === canonicalContentId
            )
        )
      )
      // The operation may be an exact ledger replay while a newer pending
      // batch already exists for this target. Reconcile authoritatively
      // without flashing the tab-level loading state.
      await loadQueue(page, { silent: true })
    } catch (err) {
      logger.error('Error performing moderation action:', err)
    } finally {
      if (
        clearOperation &&
        operationId !== null &&
        operationByTarget.current.get(key)?.operationId === operationId
      ) {
        operationByTarget.current.delete(key)
      }
      setActionLoading((prev) => ({ ...prev, [key]: false }))
    }
  }

  const toggleExpand = (key: string) => {
    setExpandedContent((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <Card title={t('moderationQueue')}>
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
              const key = `${item.content_type}-${item.content_id.toLowerCase()}`
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
                  <Box
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      marginBottom: tokens.spacing[3],
                    }}
                  >
                    <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
                      <Box
                        style={{
                          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                          borderRadius: tokens.radius.sm,
                          background:
                            item.content_type === 'post'
                              ? tokens.colors.accent.primary
                              : tokens.colors.accent.warning,
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
                          background:
                            item.report_count >= 5
                              ? tokens.colors.accent.error
                              : tokens.colors.bg.tertiary,
                          color:
                            item.report_count >= 5
                              ? tokens.colors.white
                              : tokens.colors.text.primary,
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
                    {isExpanded
                      ? 'Hide reports'
                      : `Show ${item.report_count} report${item.report_count !== 1 ? 's' : ''}`}
                  </Button>

                  {/* Individual reports */}
                  {isExpanded && (
                    <Box
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: tokens.spacing[2],
                        marginBottom: tokens.spacing[3],
                      }}
                    >
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
                            <Text
                              size="xs"
                              color="tertiary"
                              style={{ marginTop: tokens.spacing[1] }}
                            >
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
                          onClick={() => handleAction(item.content_type, item.content_id, 'warn')}
                          disabled={isActing}
                          style={{
                            background: tokens.colors.accent.warning,
                            color: tokens.colors.white,
                          }}
                        >
                          Warn User
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleAction(item.content_type, item.content_id, 'ban')}
                          disabled={isActing}
                          style={{
                            background: tokens.colors.accent.error,
                            color: tokens.colors.white,
                          }}
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
            <Box
              style={{
                marginTop: tokens.spacing[4],
                display: 'flex',
                justifyContent: 'center',
                gap: tokens.spacing[2],
              }}
            >
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
