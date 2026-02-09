'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { useAdminAuth } from '../hooks/useAdminAuth'

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

const TIER_LABELS: Record<string, string> = {
  tier1: 'Tier 1 - 头部KOL',
  tier2: 'Tier 2 - 中腰部',
  tier3: 'Tier 3 - 社区原生',
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: '待审核', color: '#f59e0b' },
  approved: { label: '已通过', color: '#10b981' },
  rejected: { label: '已拒绝', color: '#ef4444' },
}

export default function AdminKolPage() {
  const { accessToken, isAdmin, authChecking } = useAdminAuth()
  const [applications, setApplications] = useState<KolApplication[]>([])
  const [filter, setFilter] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({})

  const fetchApplications = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/kol/review?status=${filter}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()
      setApplications(data.data || [])
    } catch {
      console.error('Failed to fetch applications')
    } finally {
      setLoading(false)
    }
  }, [accessToken, filter])

  useEffect(() => {
    if (isAdmin && accessToken) fetchApplications()
  }, [isAdmin, accessToken, fetchApplications])

  const handleReview = async (applicationId: string, action: 'approved' | 'rejected') => {
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
      console.error('Review failed')
    }
  }

  if (authChecking) return null
  if (!isAdmin) return null

  return (
    <>
      <TopNav />
      <div style={{ maxWidth: 900, margin: '80px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], color: 'var(--color-text-primary)', marginBottom: 24 }}>
          KOL入驻审核
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
                background: filter === s ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
                color: filter === s ? 'white' : 'var(--color-text-secondary)',
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              {STATUS_LABELS[s].label}
            </button>
          ))}
        </div>

        {loading ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>加载中...</p>
        ) : applications.length === 0 ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>暂无{STATUS_LABELS[filter].label}的申请</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {applications.map(app => (
              <div
                key={app.id}
                style={{
                  padding: 20,
                  borderRadius: 12,
                  border: '1px solid var(--color-border-primary)',
                  background: 'var(--color-bg-secondary)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: tokens.typography.fontSize.sm }}>
                    {TIER_LABELS[app.tier] || app.tier}
                  </span>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: tokens.typography.fontSize.xs,
                    color: STATUS_LABELS[app.status]?.color || 'var(--color-text-tertiary)',
                    background: 'var(--color-bg-tertiary)',
                  }}>
                    {STATUS_LABELS[app.status]?.label || app.status}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                  {app.platform && <div>平台: {app.platform}</div>}
                  {app.platform_handle && <div>账号: {app.platform_handle}</div>}
                  {app.follower_count && <div>粉丝数: {app.follower_count.toLocaleString()}</div>}
                  <div>申请时间: {new Date(app.created_at).toLocaleDateString('zh-CN')}</div>
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
                    style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-accent)', textDecoration: 'underline', display: 'block', marginBottom: 12 }}
                  >
                    查看实盘证明
                  </a>
                )}

                {filter === 'pending' && (
                  <div style={{ marginTop: 12 }}>
                    <textarea
                      placeholder="审核备注（可选）"
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
                        style={{
                          padding: '6px 16px',
                          borderRadius: 6,
                          border: 'none',
                          background: '#10b981',
                          color: 'white',
                          cursor: 'pointer',
                          fontSize: tokens.typography.fontSize.sm,
                        }}
                      >
                        通过
                      </button>
                      <button
                        onClick={() => handleReview(app.id, 'rejected')}
                        style={{
                          padding: '6px 16px',
                          borderRadius: 6,
                          border: 'none',
                          background: '#ef4444',
                          color: 'white',
                          cursor: 'pointer',
                          fontSize: tokens.typography.fontSize.sm,
                        }}
                      >
                        拒绝
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
