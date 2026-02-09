'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface ReportButtonProps {
  contentType: 'post' | 'comment' | 'profile'
  contentId: string
}

const REASON_KEYS = [
  { value: 'spam', key: 'reportReasonSpam' },
  { value: 'scam', key: 'reportReasonFraud' },
  { value: 'harassment', key: 'reportReasonHarassment' },
  { value: 'misinformation', key: 'reportReasonMisinformation' },
  { value: 'nsfw', key: 'reportReasonInappropriate' },
  { value: 'other', key: 'reportReasonOther' },
] as const

export default function ReportButton({ contentType, contentId }: ReportButtonProps) {
  const { t } = useLanguage()
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
        setError(t('pleaseLogin'))
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
        setError(data.error || t('reportFailed'))
      } else {
        setDone(true)
      }
    } catch {
      setError(t('networkError'))
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <span style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)' }}>
        {t('reportSubmitted')}
      </span>
    )
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => {
          if (!open) {
            // Reset form when opening
            setReason('')
            setDescription('')
            setError('')
          }
          setOpen(!open)
        }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--color-text-tertiary)',
          fontSize: tokens.typography.fontSize.xs,
          padding: '2px 4px',
        }}
        title={t('report')}
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
            boxShadow: '0 4px 12px var(--color-overlay-light)',
            zIndex: 100,
          }}
        >
          <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: tokens.typography.fontSize.sm, marginBottom: 12, marginTop: 0 }}>
            {t('reportReasonLabel')}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {REASON_KEYS.map(r => (
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
                {t(r.key)}
              </label>
            ))}
          </div>

          <textarea
            placeholder={t('reportDetailsPlaceholder')}
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
              {loading ? t('reportSubmitting') : t('reportSubmit')}
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
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
