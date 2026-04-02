'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'
import { trackEvent } from '@/lib/analytics/track'

interface ReferralData {
  referral_code: string
  referral_count: number
  referral_link: string
}

const REFERRAL_REWARD_THRESHOLD = 3
const REFERRAL_REWARD = '1 month Pro free'

export default function ReferralCard() {
  const { language } = useLanguage()
  const { userId, getAuthHeadersAsync } = useAuthSession()
  const [data, setData] = useState<ReferralData | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [generating, setGenerating] = useState(false)

  const fetchReferralData = useCallback(async () => {
    if (!userId) return
    try {
      const authHeaders = await getAuthHeadersAsync()
      const res = await fetch('/api/referral', { headers: authHeaders })
      if (res.ok) {
        const json = await res.json()
        setData(json)
      }
    } catch {
      // Intentionally swallowed: referral data fetch is best-effort
    } finally {
      setLoading(false)
    }
  }, [userId, getAuthHeadersAsync])

  useEffect(() => {
    fetchReferralData()
  }, [fetchReferralData])

  const generateCode = async () => {
    if (!userId || generating) return
    setGenerating(true)
    try {
      const authHeaders = await getAuthHeadersAsync()
      const csrfHeaders = getCsrfHeaders()
      const res = await fetch('/api/referral', {
        method: 'POST',
        headers: { ...authHeaders, ...csrfHeaders },
      })
      if (res.ok) {
        const json = await res.json()
        setData(prev => prev ? { ...prev, ...json } : { referral_count: 0, ...json })
      }
    } catch {
      // Intentionally swallowed
    } finally {
      setGenerating(false)
    }
  }

  const copyLink = async () => {
    if (!data?.referral_link) return
    try {
      await navigator.clipboard.writeText(data.referral_link)
      setCopied(true)
      trackEvent('copy_referral_link')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = data.referral_link
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (!userId) return null
  if (loading) return null

  const progress = data ? Math.min(data.referral_count / REFERRAL_REWARD_THRESHOLD, 1) : 0
  const rewardEarned = data ? data.referral_count >= REFERRAL_REWARD_THRESHOLD : false

  return (
    <div style={{
      background: tokens.glass.bg.medium,
      border: tokens.glass.border.light,
      borderRadius: tokens.radius.xl,
      padding: tokens.spacing[5],
      backdropFilter: tokens.glass.blur.sm,
      WebkitBackdropFilter: tokens.glass.blur.sm,
    }}>
      {/* Header */}
      <h3 style={{
        fontSize: tokens.typography.fontSize.lg,
        fontWeight: tokens.typography.fontWeight.semibold,
        color: tokens.colors.text.primary,
        marginBottom: tokens.spacing[1],
      }}>
        {language === 'zh' ? '邀请好友' : language === 'ja' ? '友達を招待' : language === 'ko' ? '친구 초대' : 'Invite Friends'}
      </h3>
      <p style={{
        fontSize: tokens.typography.fontSize.sm,
        color: tokens.colors.text.secondary,
        marginBottom: tokens.spacing[4],
      }}>
        {language === 'zh'
          ? `邀请 ${REFERRAL_REWARD_THRESHOLD} 位好友注册，获得 ${REFERRAL_REWARD}`
          : `Refer ${REFERRAL_REWARD_THRESHOLD} friends → ${REFERRAL_REWARD}`}
      </p>

      {/* Referral link */}
      {data?.referral_code ? (
        <div style={{ marginBottom: tokens.spacing[4] }}>
          <div style={{
            display: 'flex',
            gap: tokens.spacing[2],
            alignItems: 'center',
          }}>
            <input
              type="text"
              readOnly
              value={data.referral_link}
              style={{
                flex: 1,
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.lg,
                border: tokens.glass.border.light,
                background: tokens.glass.bg.light,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                outline: 'none',
              }}
            />
            <button
              onClick={copyLink}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: copied ? tokens.colors.accent.success : tokens.colors.accent.primary,
                color: '#fff',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.medium,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {copied
                ? (language === 'zh' ? '已复制' : 'Copied!')
                : (language === 'zh' ? '复制' : 'Copy')}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={generateCode}
          disabled={generating}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.lg,
            border: 'none',
            background: tokens.colors.accent.primary,
            color: '#fff',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            cursor: generating ? 'wait' : 'pointer',
            marginBottom: tokens.spacing[4],
            opacity: generating ? 0.7 : 1,
          }}
        >
          {generating
            ? (language === 'zh' ? '生成中...' : 'Generating...')
            : (language === 'zh' ? '生成邀请链接' : 'Generate Referral Link')}
        </button>
      )}

      {/* Progress */}
      {data && (
        <div>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: tokens.spacing[2],
          }}>
            <span style={{
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
            }}>
              {language === 'zh'
                ? `已邀请 ${data.referral_count} 人`
                : `${data.referral_count} referred`}
            </span>
            <span style={{
              fontSize: tokens.typography.fontSize.sm,
              color: rewardEarned ? tokens.colors.accent.success : tokens.colors.text.tertiary,
              fontWeight: rewardEarned ? tokens.typography.fontWeight.semibold : tokens.typography.fontWeight.normal,
            }}>
              {rewardEarned
                ? (language === 'zh' ? '奖励已解锁!' : 'Reward unlocked!')
                : `${data.referral_count}/${REFERRAL_REWARD_THRESHOLD}`}
            </span>
          </div>
          {/* Progress bar */}
          <div style={{
            height: 6,
            borderRadius: 3,
            background: tokens.glass.bg.medium,
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${progress * 100}%`,
              borderRadius: 3,
              background: rewardEarned
                ? tokens.colors.accent.success
                : `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand || tokens.colors.accent.primary})`,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}
    </div>
  )
}
