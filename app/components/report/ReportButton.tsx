'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'

interface ReportButtonProps {
  contentType: 'post' | 'comment' | 'profile'
  contentId: string
}

const REASONS = [
  { value: 'spam', label: '垃圾广告' },
  { value: 'scam', label: '诈骗' },
  { value: 'harassment', label: '骚扰' },
  { value: 'misinformation', label: '虚假信息' },
  { value: 'nsfw', label: '不当内容' },
  { value: 'other', label: '其他' },
]

export default function ReportButton({ contentType, contentId }: ReportButtonProps) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!reason) return
    setLoading(true)
    setError('')

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setError('请先登录')
        setLoading(false)
        return
      }

      const res = await fetch('/api/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ content_type: contentType, content_id: contentId, reason, description }),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '举报失败')
      } else {
        setDone(true)
      }
    } catch {
      setError('网络错误')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <span style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)' }}>
        已举报
      </span>
    )
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--color-text-tertiary)',
          fontSize: tokens.typography.fontSize.xs,
          padding: '2px 4px',
        }}
        title="举报"
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" y1="22" x2="4" y2="15" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 4,
            width: 260,
            padding: 16,
            borderRadius: 12,
            border: '1px solid var(--color-border-primary)',
            background: 'var(--color-bg-secondary)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 100,
          }}
        >
          <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: tokens.typography.fontSize.sm, marginBottom: 12, marginTop: 0 }}>
            举报原因
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {REASONS.map(r => (
              <label
                key={r.value}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                  color: 'var(--color-text-secondary)',
                }}
              >
                <input
                  type="radio"
                  name="report-reason"
                  value={r.value}
                  checked={reason === r.value}
                  onChange={e => setReason(e.target.value)}
                />
                {r.label}
              </label>
            ))}
          </div>

          <textarea
            placeholder="补充说明（可选）"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={2}
            style={{
              width: '100%',
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-primary)',
              color: 'var(--color-text-primary)',
              fontSize: tokens.typography.fontSize.xs,
              resize: 'none',
              outline: 'none',
              marginBottom: 8,
            }}
          />

          {error && <p style={{ color: '#ef4444', fontSize: tokens.typography.fontSize.xs, margin: '0 0 8px' }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleSubmit}
              disabled={!reason || loading}
              style={{
                flex: 1,
                padding: '6px 12px',
                borderRadius: 6,
                border: 'none',
                background: !reason || loading ? 'var(--color-bg-tertiary)' : '#ef4444',
                color: 'white',
                cursor: !reason || loading ? 'not-allowed' : 'pointer',
                fontSize: tokens.typography.fontSize.xs,
              }}
            >
              {loading ? '提交中...' : '提交举报'}
            </button>
            <button
              onClick={() => setOpen(false)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid var(--color-border-primary)',
                background: 'transparent',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
