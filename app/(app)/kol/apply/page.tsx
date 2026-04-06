'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function KolApplyPage() {
  const router = useRouter()
  const { t } = useLanguage()
  const [form, setForm] = useState({
    tier: '',
    platform: '',
    platform_handle: '',
    follower_count: '',
    description: '',
    proof_url: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const TIERS = [
    { value: 'tier1', label: t('kolApplyTier1Label'), desc: t('kolApplyTier1Desc') },
    { value: 'tier2', label: t('kolApplyTier2Label'), desc: t('kolApplyTier2Desc') },
    { value: 'tier3', label: t('kolApplyTier3Label'), desc: t('kolApplyTier3Desc') },
  ]

  const PLATFORMS = [
    { value: 'twitter', label: t('kolApplyPlatformTwitter') },
    { value: 'youtube', label: t('kolApplyPlatformYoutube') },
    { value: 'telegram', label: t('kolApplyPlatformTelegram') },
    { value: 'tiktok', label: t('kolApplyPlatformTiktok') },
    { value: 'other', label: t('kolApplyPlatformOther') },
  ]

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!form.platform) {
      setError(t('kolApplyErrorSelectPlatform'))
      return
    }
    if (!form.platform_handle.trim()) {
      setError(t('kolApplyErrorEnterHandle'))
      return
    }

    setLoading(true)
    setError('')

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.push('/login?redirect=/kol/apply')
        return
      }

      const res = await fetch('/api/kol/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(form),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || t('kolApplySubmissionFailed'))
        return
      }

      setSuccess(true)
    } catch {
      setError(t('kolApplyNetworkError'))
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: tokens.radius.md,
    border: '1px solid var(--color-border-primary)',
    background: 'var(--color-bg-secondary)',
    color: 'var(--color-text-primary)',
    fontSize: tokens.typography.fontSize.sm,
    outline: 'none',
  }

  if (success) {
    return (
      <>
        <TopNav />
        <div style={{ maxWidth: 600, margin: '80px auto', padding: '0 16px', textAlign: 'center' }}>
          <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], color: 'var(--color-text-primary)', marginBottom: 16 }}>
            {t('kolApplySubmitted')}
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: 24 }}>
            {t('kolApplySubmittedDesc')}
          </p>
          <button
            onClick={() => router.push('/')}
            style={{
              padding: '10px 24px',
              borderRadius: tokens.radius.md,
              background: 'var(--color-accent-primary)',
              color: tokens.colors.white,
              border: 'none',
              cursor: 'pointer',
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            {t('kolApplyBackHome')}
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <TopNav />
      <div style={{ maxWidth: 600, margin: '80px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], color: 'var(--color-text-primary)', marginBottom: 8 }}>
          {t('kolApplyTitle')}
        </h1>
        <p style={{ color: 'var(--color-text-secondary)', marginBottom: 32, fontSize: tokens.typography.fontSize.sm }}>
          {t('kolApplySubtitle')}
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Tier Selection */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {t('kolApplyTierLabel')}
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {TIERS.map(tier => (
                <label
                  key={tier.value}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: 12,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${form.tier === tier.value ? 'var(--color-accent-primary)' : 'var(--color-border-primary)'}`,
                    background: form.tier === tier.value ? 'var(--color-bg-tertiary)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="tier"
                    value={tier.value}
                    checked={form.tier === tier.value}
                    onChange={e => setForm({ ...form, tier: e.target.value })}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <div style={{ color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>{tier.label}</div>
                    <div style={{ color: 'var(--color-text-tertiary)', fontSize: tokens.typography.fontSize.xs, marginTop: 2 }}>{tier.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Platform */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {t('kolApplyPlatformLabel')}
            </label>
            <select
              value={form.platform}
              onChange={e => setForm({ ...form, platform: e.target.value })}
              style={inputStyle}
            >
              <option value="">{t('kolApplySelectPlatform')}</option>
              {PLATFORMS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* Handle */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {t('kolApplyHandleLabel')}
            </label>
            <input
              type="text"
              placeholder={t('kolApplyHandlePlaceholder')}
              value={form.platform_handle}
              onChange={e => setForm({ ...form, platform_handle: e.target.value })}
              style={inputStyle}
            />
          </div>

          {/* Follower Count */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {t('kolApplyFollowerLabel')}
            </label>
            <input
              type="number"
              placeholder={t('kolApplyFollowerPlaceholder')}
              value={form.follower_count}
              onChange={e => setForm({ ...form, follower_count: e.target.value })}
              style={inputStyle}
            />
          </div>

          {/* Description */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {t('kolApplyAboutLabel')}
            </label>
            <textarea
              placeholder={t('kolApplyAboutPlaceholder')}
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              rows={4}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          {/* Proof URL */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {t('kolApplyProofLabel')}
            </label>
            <input
              type="url"
              placeholder={t('kolApplyProofPlaceholder')}
              value={form.proof_url}
              onChange={e => setForm({ ...form, proof_url: e.target.value })}
              style={inputStyle}
            />
          </div>

          {error && (
            <p style={{ color: 'var(--color-accent-error)', fontSize: tokens.typography.fontSize.sm, margin: 0 }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !form.tier}
            style={{
              padding: '12px 24px',
              borderRadius: tokens.radius.md,
              background: loading || !form.tier ? 'var(--color-bg-tertiary)' : 'var(--color-accent-primary)',
              color: tokens.colors.white,
              border: 'none',
              cursor: loading || !form.tier ? 'not-allowed' : 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
            }}
          >
            {loading ? t('kolApplySubmitting') : t('kolApplySubmit')}
          </button>
        </form>
      </div>
    </>
  )
}
