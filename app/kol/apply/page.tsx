'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const TIERS = [
  { value: 'tier1', labelZh: 'Tier 1 - 头部KOL', labelEn: 'Tier 1 - Top KOL', descZh: '粉丝数>10万，享有专属主页、认证标识、推荐位曝光、收入分成', descEn: 'Over 100K followers. Exclusive profile, verified badge, featured placement, revenue sharing' },
  { value: 'tier2', labelZh: 'Tier 2 - 中腰部KOL', labelEn: 'Tier 2 - Mid-tier KOL', descZh: '提供实盘收益证明，享有认证标识、推荐位曝光', descEn: 'Provide live trading proof. Verified badge, featured placement' },
  { value: 'tier3', labelZh: 'Tier 3 - 社区原生', labelEn: 'Tier 3 - Community Native', descZh: '社区活跃用户，逐步升级权限，算法推荐', descEn: 'Active community member. Gradual privilege upgrades, algorithmic recommendations' },
]

const PLATFORMS = [
  { value: 'twitter', label: 'Twitter / X' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'other', labelZh: '其他', labelEn: 'Other' },
]

export default function KolApplyPage() {
  const router = useRouter()
  const { language } = useLanguage()
  const isZh = language === 'zh'
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!form.platform) {
      setError(isZh ? '请选择主要平台' : 'Please select a platform')
      return
    }
    if (!form.platform_handle.trim()) {
      setError(isZh ? '请填写平台账号' : 'Please enter your platform handle')
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
        setError(data.error || (isZh ? '提交失败' : 'Submission failed'))
        return
      }

      setSuccess(true)
    } catch {
      setError(isZh ? '网络错误，请稍后重试' : 'Network error, please try again later')
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
            {isZh ? '申请已提交' : 'Application Submitted'}
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: 24 }}>
            {isZh ? '我们会尽快审核你的KOL入驻申请，审核结果将通过站内通知告知。' : 'We will review your KOL application as soon as possible. Results will be sent via in-app notification.'}
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
            {isZh ? '返回首页' : 'Back to Home'}
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
          {isZh ? 'KOL入驻申请' : 'KOL Application'}
        </h1>
        <p style={{ color: 'var(--color-text-secondary)', marginBottom: 32, fontSize: tokens.typography.fontSize.sm }}>
          {isZh ? '加入Arena认证KOL计划，获得认证标识和更多曝光机会。' : 'Join the Arena Verified KOL program. Get a verified badge and more exposure.'}
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Tier Selection */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {isZh ? '申请等级 *' : 'Application Tier *'}
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {TIERS.map(t => (
                <label
                  key={t.value}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: 12,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${form.tier === t.value ? 'var(--color-accent-primary)' : 'var(--color-border-primary)'}`,
                    background: form.tier === t.value ? 'var(--color-bg-tertiary)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="tier"
                    value={t.value}
                    checked={form.tier === t.value}
                    onChange={e => setForm({ ...form, tier: e.target.value })}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <div style={{ color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>{isZh ? t.labelZh : t.labelEn}</div>
                    <div style={{ color: 'var(--color-text-tertiary)', fontSize: tokens.typography.fontSize.xs, marginTop: 2 }}>{isZh ? t.descZh : t.descEn}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Platform */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {isZh ? '主要平台' : 'Primary Platform'}
            </label>
            <select
              value={form.platform}
              onChange={e => setForm({ ...form, platform: e.target.value })}
              style={inputStyle}
            >
              <option value="">{isZh ? '请选择平台' : 'Select a platform'}</option>
              {PLATFORMS.map(p => (
                <option key={p.value} value={p.value}>{'labelZh' in p ? (isZh ? p.labelZh : p.labelEn) : p.label}</option>
              ))}
            </select>
          </div>

          {/* Handle */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {isZh ? '平台账号' : 'Platform Handle'}
            </label>
            <input
              type="text"
              placeholder={isZh ? '例如: @yourhandle' : 'e.g. @yourhandle'}
              value={form.platform_handle}
              onChange={e => setForm({ ...form, platform_handle: e.target.value })}
              style={inputStyle}
            />
          </div>

          {/* Follower Count */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {isZh ? '粉丝数量' : 'Follower Count'}
            </label>
            <input
              type="number"
              placeholder={isZh ? '请输入粉丝数量' : 'Enter follower count'}
              value={form.follower_count}
              onChange={e => setForm({ ...form, follower_count: e.target.value })}
              style={inputStyle}
            />
          </div>

          {/* Description */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {isZh ? '自我介绍' : 'About You'}
            </label>
            <textarea
              placeholder={isZh ? '请介绍你的交易风格、擅长领域等' : 'Describe your trading style, areas of expertise, etc.'}
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              rows={4}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          {/* Proof URL */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--color-text-primary)', fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {isZh ? '实盘证明链接' : 'Trading Proof URL'}
            </label>
            <input
              type="url"
              placeholder={isZh ? '交易记录截图或链接（Tier1/Tier2建议提供）' : 'Trading records screenshot or link (recommended for Tier 1/2)'}
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
            {loading ? (isZh ? '提交中...' : 'Submitting...') : (isZh ? '提交申请' : 'Submit Application')}
          </button>
        </form>
      </div>
    </>
  )
}
