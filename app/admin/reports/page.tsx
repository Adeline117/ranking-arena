'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
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
  pending: { key: 'adminPending', color: '#f59e0b' },
  reviewed: { key: 'adminResolved', color: '#3b82f6' },
  actioned: { key: 'adminResolved', color: '#10b981' },
  dismissed: { key: 'adminDismissed', color: '#6b7280' },
}

export default function AdminReportsPage() {
  const { t } = useLanguage()
  const { accessToken, isAdmin, authChecking } = useAdminAuth()
  const [reports, setReports] = useState<ContentReport[]>([])
  const [filter, setFilter] = useState('pending')
  const [loading, setLoading] = useState(true)

  const fetchReports = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const _res = await fetch(`/api/admin/kol/review?status=${filter}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      // Use admin supabase directly for reports
      const { createClient } = await import('@supabase/supabase-js')
      const _supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || '',
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
      )
      // Fetch via API instead
      const response = await fetch('/api/admin/reports?' + new URLSearchParams({ status: filter }), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
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

  useEffect(() => {
    if (isAdmin && accessToken) fetchReports()
  }, [isAdmin, accessToken, fetchReports])

  if (authChecking || !isAdmin) return null

  return (
    <>
      <TopNav />
      <div style={{ maxWidth: 900, margin: '80px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], color: 'var(--color-text-primary)', marginBottom: 24 }}>
          {t('adminReportHandling')}
        </h1>

        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {['pending', 'reviewed', 'actioned', 'dismissed'].map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              style={{
                padding: '6px 16px',
                borderRadius: 6,
                border: 'none',
                background: filter === s ? 'var(--color-accent-primary)' : 'var(--color-bg-tertiary)',
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
            {reports.map(report => (
              <div
                key={report.id}
                style={{
                  padding: 16,
                  borderRadius: tokens.radius.lg,
                  border: '1px solid var(--color-border-primary)',
                  background: 'var(--color-bg-secondary)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: tokens.radius.sm,
                      fontSize: tokens.typography.fontSize.xs,
                      background: 'var(--color-bg-tertiary)',
                      color: 'var(--color-text-secondary)',
                    }}>
                      {report.content_type}
                    </span>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: tokens.radius.sm,
                      fontSize: tokens.typography.fontSize.xs,
                      background: '#ef44441a',
                      color: '#ef4444',
                    }}>
                      {REASON_KEYS[report.reason] ? t(REASON_KEYS[report.reason]) : report.reason}
                    </span>
                  </div>
                  <span style={{
                    fontSize: tokens.typography.fontSize.xs,
                    color: STATUS_MAP[report.status]?.color,
                  }}>
                    {STATUS_MAP[report.status] ? t(STATUS_MAP[report.status].key) : report.status}
                  </span>
                </div>

                {report.description && (
                  <p style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)', margin: '8px 0' }}>
                    {report.description}
                  </p>
                )}

                <div style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)' }}>
                  ID: {report.content_id} | {new Date(report.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
