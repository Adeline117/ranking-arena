'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useAdminAuth } from '../hooks/useAdminAuth'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

interface ContentReport {
  id: number
  reporter_id: string
  content_type: string
  content_id: string
  reason: string
  description: string | null
  status: string
  action_taken: string | null
  created_at: string
}

const REASON_KEYS: Record<string, string> = {
  spam: 'adminReportSpam',
  scam: 'adminReportScam',
  harassment: 'adminReportHarassment2',
  misinformation: 'adminReportMisinformation2',
  nsfw: 'adminReportNsfw',
  other: 'adminReportOther2',
}

const STATUS_MAP: Record<string, { key: string; color: string }> = {
  pending: { key: 'adminPending', color: 'var(--color-score-average)' },
  reviewed: { key: 'adminResolved', color: 'var(--color-score-profitability)' },
  actioned: { key: 'adminResolved', color: 'var(--color-score-great)' },
  dismissed: { key: 'adminDismissed', color: 'var(--color-score-low)' },
}

export default function AdminReportsPage() {
  const { t } = useLanguage()
  const { accessToken, isAdmin, authChecking } = useAdminAuth()
  const [reports, setReports] = useState<ContentReport[]>([])
  const [filter, setFilter] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<Record<number, boolean>>({})

  const fetchReports = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const response = await fetch(
        '/api/admin/reports?' + new URLSearchParams({ status: filter }),
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      )
      if (response.ok) {
        const data = await response.json()
        setReports(data.data || [])
      }
    } catch {
      logger.error('Failed to fetch reports')
    } finally {
      setLoading(false)
    }
  }, [accessToken, filter])

  // Triage: resolve (delete offending content) or dismiss the report.
  // Wired to the existing POST /api/admin/reports/[id]/resolve endpoint,
  // which only acts on pending reports — on success the row leaves the
  // pending filter, so drop it from the list optimistically.
  const handleAction = useCallback(
    async (id: number, action: 'resolve' | 'dismiss') => {
      if (!accessToken) return
      setActionLoading((prev) => ({ ...prev, [id]: true }))
      try {
        const res = await fetch(`/api/admin/reports/${id}/resolve`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action }),
        })
        if (res.ok) {
          setReports((prev) => prev.filter((r) => r.id !== id))
        } else {
          logger.error('Report triage action failed', { status: res.status })
        }
      } catch (err) {
        logger.error('Report triage action error', { err })
      } finally {
        setActionLoading((prev) => ({ ...prev, [id]: false }))
      }
    },
    [accessToken]
  )

  // Best-effort deep link to the offending content. Only 'post' has a stable
  // public route keyed by id; other content types have no standalone page.
  const contentLink = (report: ContentReport): string | null =>
    report.content_type === 'post' ? `/post/${report.content_id}` : null

  useEffect(() => {
    if (isAdmin && accessToken) fetchReports()
  }, [isAdmin, accessToken, fetchReports])

  if (authChecking) return null

  if (!isAdmin) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h1
            style={{
              fontSize: tokens.typography.fontSize['2xl'],
              marginBottom: 8,
            }}
          >
            {t('noPermissionAccess')}
          </h1>
          <p style={{ color: 'var(--color-text-secondary)' }}>{t('noAdminPermission')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div style={{ maxWidth: 900, margin: '80px auto', padding: '0 16px' }}>
        <h1
          style={{
            fontSize: tokens.typography.fontSize['2xl'],
            color: 'var(--color-text-primary)',
            marginBottom: 24,
          }}
        >
          {t('adminReportHandling')}
        </h1>

        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {['pending', 'reviewed', 'actioned', 'dismissed'].map((s) => (
            <button
              key={s}
              aria-pressed={filter === s}
              onClick={() => setFilter(s)}
              style={{
                padding: '6px 16px',
                borderRadius: tokens.radius.sm,
                border: 'none',
                background:
                  filter === s ? 'var(--color-accent-primary)' : 'var(--color-bg-tertiary)',
                color: filter === s ? tokens.colors.white : 'var(--color-text-secondary)',
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              {t(STATUS_MAP[s].key)}
            </button>
          ))}
        </div>

        {loading ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>{t('loading')}</p>
        ) : reports.length === 0 ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>{t('adminNoReports')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {reports.map((report) => (
              <div
                key={report.id}
                style={{
                  padding: 16,
                  borderRadius: tokens.radius.lg,
                  border: '1px solid var(--color-border-primary)',
                  background: 'var(--color-bg-secondary)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: tokens.radius.sm,
                        fontSize: tokens.typography.fontSize.xs,
                        background: 'var(--color-bg-tertiary)',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {report.content_type}
                    </span>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: tokens.radius.sm,
                        fontSize: tokens.typography.fontSize.xs,
                        background: 'var(--color-accent-error-10)',
                        color: 'var(--color-accent-error)',
                      }}
                    >
                      {REASON_KEYS[report.reason] ? t(REASON_KEYS[report.reason]) : report.reason}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: STATUS_MAP[report.status]?.color,
                    }}
                  >
                    {STATUS_MAP[report.status] ? t(STATUS_MAP[report.status].key) : report.status}
                  </span>
                </div>

                {report.description && (
                  <p
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      color: 'var(--color-text-secondary)',
                      margin: '8px 0',
                    }}
                  >
                    {report.description}
                  </p>
                )}

                <div
                  style={{
                    fontSize: tokens.typography.fontSize.xs,
                    color: 'var(--color-text-tertiary)',
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <span>
                    ID: {report.content_id} | {new Date(report.created_at).toLocaleString()}
                  </span>
                  {contentLink(report) && (
                    <a
                      href={contentLink(report) as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--color-accent-primary)' }}
                    >
                      {t('adminViewContent')}
                    </a>
                  )}
                </div>

                {/* Triage actions — only pending reports are actionable */}
                {report.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button
                      onClick={() => handleAction(report.id, 'resolve')}
                      disabled={actionLoading[report.id]}
                      style={{
                        padding: '6px 16px',
                        borderRadius: tokens.radius.sm,
                        border: 'none',
                        background: 'var(--color-accent-error)',
                        color: tokens.colors.white,
                        cursor: actionLoading[report.id] ? 'not-allowed' : 'pointer',
                        opacity: actionLoading[report.id] ? 0.6 : 1,
                        fontSize: tokens.typography.fontSize.sm,
                      }}
                    >
                      {actionLoading[report.id] ? t('processing') : t('adminDeleteContent')}
                    </button>
                    <button
                      onClick={() => handleAction(report.id, 'dismiss')}
                      disabled={actionLoading[report.id]}
                      style={{
                        padding: '6px 16px',
                        borderRadius: tokens.radius.sm,
                        border: '1px solid var(--color-border-primary)',
                        background: 'var(--color-bg-tertiary)',
                        color: 'var(--color-text-secondary)',
                        cursor: actionLoading[report.id] ? 'not-allowed' : 'pointer',
                        opacity: actionLoading[report.id] ? 0.6 : 1,
                        fontSize: tokens.typography.fontSize.sm,
                      }}
                    >
                      {t('adminDismissReport')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
