'use client'

import { useState, useEffect, useCallback } from 'react'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { useAdminAuth } from '../hooks/useAdminAuth'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

interface KolApplication {
  id: string
  user_id: string
  tier: string
  platform: string | null
  platform_handle: string | null
  follower_count: number | null
  description: string | null
  proof_url: string | null
  status: string
  reviewer_notes: string | null
  created_at: string
}

const TIER_KEYS: Record<string, string> = {
  tier1: 'kolTier1',
  tier2: 'kolTier2',
  tier3: 'kolTier3',
}

const STATUS_KEYS: Record<string, { key: string; color: string }> = {
  pending: { key: 'kolStatusPending', color: 'var(--color-score-average)' },
  approved: { key: 'kolStatusApproved', color: 'var(--color-score-great)' },
  rejected: { key: 'kolStatusRejected', color: 'var(--color-accent-error)' },
}

export default function AdminKolPage() {
  const { t, language } = useLanguage()
  const { accessToken, isAdmin, authChecking } = useAdminAuth()
  const [applications, setApplications] = useState<KolApplication[]>([])
  const [filter, setFilter] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [reviewing, setReviewing] = useState<Record<string, boolean>>({})
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({})

  const fetchApplications = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setLoadError(false)
    try {
      const res = await fetch(`/api/admin/kol/review?status=${filter}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch')
      setApplications(data.data || [])
    } catch {
      logger.error('Failed to fetch applications')
      setLoadError(true)
      setApplications([])
    } finally {
      setLoading(false)
    }
  }, [accessToken, filter])

  useEffect(() => {
    if (isAdmin && accessToken) fetchApplications()
  }, [isAdmin, accessToken, fetchApplications])

  const handleReview = async (applicationId: string, action: 'approved' | 'rejected') => {
    setReviewing(prev => ({ ...prev, [applicationId]: true }))
    try {
      const res = await fetch('/api/admin/kol/review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          applicationId,
          action,
          reviewer_notes: reviewNotes[applicationId] || '',
        }),
      })
      if (res.ok) {
        fetchApplications()
      }
    } catch {
      logger.error('Review failed')
    } finally {
      setReviewing(prev => ({ ...prev, [applicationId]: false }))
    }
  }

  if (authChecking) return null
  if (!isAdmin) return null

  return (
    <>
      <TopNav />
      <div style={{ maxWidth: 900, margin: '80px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], color: 'var(--color-text-primary)', marginBottom: 24 }}>
          {t('kolReviewTitle')}
        </h1>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {['pending', 'approved', 'rejected'].map(s => (
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
              {t(STATUS_KEYS[s].key)}
            </button>
          ))}
        </div>

        {loading ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>{t('loading')}</p>
        ) : loadError ? (
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <p style={{ color: 'var(--color-accent-error)', marginBottom: 12 }}>{t('loadFailed')}</p>
            <button
              onClick={() => fetchApplications()}
              style={{
                padding: '6px 16px',
                borderRadius: 6,
                border: '1px solid var(--color-border-primary)',
                background: 'var(--color-bg-tertiary)',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              {t('retry')}
            </button>
          </div>
        ) : applications.length === 0 ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>{t('kolNoApplications').replace('{status}', t(STATUS_KEYS[filter].key))}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {applications.map(app => (
              <div
                key={app.id}
                style={{
                  padding: 20,
                  borderRadius: tokens.radius.lg,
                  border: '1px solid var(--color-border-primary)',
                  background: 'var(--color-bg-secondary)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: tokens.typography.fontSize.sm }}>
                    {t(TIER_KEYS[app.tier] || '') || app.tier}
                  </span>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: tokens.radius.sm,
                    fontSize: tokens.typography.fontSize.xs,
                    color: STATUS_KEYS[app.status]?.color || 'var(--color-text-tertiary)',
                    background: 'var(--color-bg-tertiary)',
                  }}>
                    {STATUS_KEYS[app.status] ? t(STATUS_KEYS[app.status].key) : app.status}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                  {app.platform && <div>{t('kolPlatform')}: {app.platform}</div>}
                  {app.platform_handle && <div>{t('kolAccount')}: {app.platform_handle}</div>}
                  {app.follower_count && <div>{t('kolFollowerCount')}: {app.follower_count.toLocaleString()}</div>}
                  <div>{t('kolApplyTime')}: {new Date(app.created_at).toLocaleDateString(getLocaleFromLanguage(language), { year: 'numeric', month: 'short', day: 'numeric' })}</div>
                </div>

                {app.description && (
                  <p style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                    {app.description}
                  </p>
                )}

                {app.proof_url && (
                  <a
                    href={app.proof_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-accent-primary)', textDecoration: 'underline', display: 'block', marginBottom: 12 }}
                  >
                    {t('kolViewProof')}
                  </a>
                )}

                {filter === 'pending' && (
                  <div style={{ marginTop: 12 }}>
                    <textarea
                      placeholder={t('kolReviewNote')}
                      value={reviewNotes[app.id] || ''}
                      onChange={e => setReviewNotes({ ...reviewNotes, [app.id]: e.target.value })}
                      rows={2}
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: 6,
                        border: '1px solid var(--color-border-primary)',
                        background: 'var(--color-bg-primary)',
                        color: 'var(--color-text-primary)',
                        fontSize: tokens.typography.fontSize.sm,
                        resize: 'vertical',
                        marginBottom: 8,
                        outline: 'none',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => handleReview(app.id, 'approved')}
                        disabled={reviewing[app.id]}
                        style={{
                          padding: '6px 16px',
                          borderRadius: 6,
                          border: 'none',
                          background: 'var(--color-score-great)',
                          color: tokens.colors.white,
                          cursor: reviewing[app.id] ? 'not-allowed' : 'pointer',
                          opacity: reviewing[app.id] ? 0.6 : 1,
                          fontSize: tokens.typography.fontSize.sm,
                        }}
                      >
                        {reviewing[app.id] ? t('processing') : t('kolApprove')}
                      </button>
                      <button
                        onClick={() => handleReview(app.id, 'rejected')}
                        disabled={reviewing[app.id]}
                        style={{
                          padding: '6px 16px',
                          borderRadius: 6,
                          border: 'none',
                          background: 'var(--color-accent-error)',
                          color: tokens.colors.white,
                          cursor: reviewing[app.id] ? 'not-allowed' : 'pointer',
                          opacity: reviewing[app.id] ? 0.6 : 1,
                          fontSize: tokens.typography.fontSize.sm,
                        }}
                      >
                        {reviewing[app.id] ? t('processing') : t('kolReject')}
                      </button>
                    </div>
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
