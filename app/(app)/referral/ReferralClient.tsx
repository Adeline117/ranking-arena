'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { getCsrfHeaders } from '@/lib/api/client'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  REFERRAL_REWARD_THRESHOLD,
  REFERRAL_ADVOCATE_PRO_DAYS,
  REFERRED_FRIEND_TRIAL_DAYS,
} from '@/lib/constants/referral'

interface ReferralData {
  referral_code: string
  referral_count: number
  referral_link: string
}

export default function ReferralClient() {
  const { t } = useLanguage()
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [referral, setReferral] = useState<ReferralData | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    async function init() {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        setIsAuthenticated(false)
        setLoading(false)
        return
      }
      setIsAuthenticated(true)

      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) {
        setLoading(false)
        return
      }

      try {
        const res = await fetch('/api/referral', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (res.ok) {
          const json = await res.json()
          setReferral(json)
        }
      } catch (err) {
        console.error('[referral] fetch failed:', err)
      }
      setLoading(false)
    }
    init()
  }, [])

  const handleCopy = useCallback(async () => {
    if (!referral?.referral_link) return
    try {
      await navigator.clipboard.writeText(referral.referral_link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select text
    }
  }, [referral])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) return

      const res = await fetch('/api/referral', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
      })
      if (res.ok) {
        const json = await res.json()
        setReferral((prev) => ({
          referral_code: json.referral_code,
          referral_link: json.referral_link,
          referral_count: prev?.referral_count ?? 0,
        }))
      }
    } catch (err) {
      console.error('[referral] generate failed:', err)
    } finally {
      setGenerating(false)
    }
  }, [])

  const shareUrl = referral?.referral_link || ''
  const shareText = t('referralShareText')

  const referralCount = referral?.referral_count ?? 0
  const progress = Math.min(referralCount / REFERRAL_REWARD_THRESHOLD, 1)
  const rewardEarned = referralCount >= REFERRAL_REWARD_THRESHOLD

  const rewardTitle = t('referralRewardBannerTitle')
    .replace('{count}', String(REFERRAL_REWARD_THRESHOLD))
    .replace('{days}', String(REFERRAL_ADVOCATE_PRO_DAYS))
  const rewardSubtitle = t('referralRewardBannerSubtitle')
    .replace('{count}', String(REFERRAL_REWARD_THRESHOLD))
    .replace('{days}', String(REFERRAL_ADVOCATE_PRO_DAYS))
  const step3 = t('referralStep3')
    .replace('{count}', String(REFERRAL_REWARD_THRESHOLD))
    .replace('{days}', String(REFERRAL_ADVOCATE_PRO_DAYS))
  const friendTrialNote = t('referralFriendTrialNote').replace(
    '{days}',
    String(REFERRED_FRIEND_TRIAL_DAYS)
  )

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <div
        style={{
          maxWidth: 700,
          margin: '0 auto',
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]} ${tokens.spacing[16]}`,
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: tokens.spacing[8], textAlign: 'center' }}>
          <h1
            style={{
              fontSize: 'clamp(28px, 3.5vw, 40px)',
              fontWeight: tokens.typography.fontWeight.black,
              margin: 0,
              letterSpacing: '-0.02em',
              lineHeight: 1.15,
            }}
          >
            {t('referralTitle')}
          </h1>
          <p
            style={{
              fontSize: tokens.typography.fontSize.base,
              color: tokens.colors.text.secondary,
              marginTop: tokens.spacing[2],
            }}
          >
            {t('referralPageSubtitle')}
          </p>
        </div>

        {/* Reward hero — clearly states the reward + how it works */}
        <div
          style={{
            padding: tokens.spacing[6],
            background: 'var(--color-accent-primary-08)',
            borderRadius: tokens.radius.lg,
            border: '1px solid var(--color-accent-primary-15)',
            marginBottom: tokens.spacing[6],
          }}
        >
          <div
            style={{
              fontSize: tokens.typography.fontSize.xl,
              fontWeight: tokens.typography.fontWeight.bold,
              color: tokens.colors.text.primary,
              marginBottom: tokens.spacing[2],
              lineHeight: 1.3,
            }}
          >
            {rewardTitle}
          </div>
          <p
            style={{
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
              margin: `0 0 ${tokens.spacing[4]}`,
            }}
          >
            {rewardSubtitle}
          </p>

          {/* How it works */}
          <div
            style={{
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: tokens.colors.text.primary,
              marginBottom: tokens.spacing[2],
            }}
          >
            {t('referralHowItWorks')}
          </div>
          <ol
            style={{
              margin: 0,
              paddingLeft: tokens.spacing[5],
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing[1],
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
            }}
          >
            <li>{t('referralStep1')}</li>
            <li>{t('referralStep2')}</li>
            <li>{step3}</li>
          </ol>

          {REFERRED_FRIEND_TRIAL_DAYS > 0 && (
            <p
              style={{
                fontSize: tokens.typography.fontSize.sm,
                color: tokens.colors.accent.success,
                margin: `${tokens.spacing[3]} 0 0`,
              }}
            >
              {friendTrialNote}
            </p>
          )}
        </div>

        {/* Auth gate */}
        {isAuthenticated === false && (
          <div
            style={{
              padding: `${tokens.spacing[16]} ${tokens.spacing[5]}`,
              textAlign: 'center',
              background: tokens.glass.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: tokens.glass.border.light,
            }}
          >
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              style={{ opacity: 0.4, marginBottom: tokens.spacing[4] }}
            >
              <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="8.5" cy="7" r="4" />
              <line x1="20" y1="8" x2="20" y2="14" />
              <line x1="23" y1="11" x2="17" y2="11" />
            </svg>
            <h2
              style={{
                fontSize: tokens.typography.fontSize.lg,
                fontWeight: tokens.typography.fontWeight.semibold,
                margin: `0 0 ${tokens.spacing[2]}`,
              }}
            >
              {t('referralSignInGateTitle')}
            </h2>
            <p
              style={{
                fontSize: tokens.typography.fontSize.base,
                color: tokens.colors.text.secondary,
                margin: `0 0 ${tokens.spacing[5]}`,
              }}
            >
              {t('referralSignInGateDesc')}
            </p>
            <Link
              href="/login"
              style={{
                display: 'inline-block',
                padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                background: 'var(--color-accent-primary)',
                color: tokens.colors.white,
                borderRadius: tokens.radius.md,
                fontWeight: tokens.typography.fontWeight.semibold,
                fontSize: tokens.typography.fontSize.base,
                textDecoration: 'none',
              }}
            >
              {t('login')}
            </Link>
          </div>
        )}

        {/* Loading */}
        {loading && isAuthenticated !== false && <LoadingSkeleton variant="card" count={2} />}

        {/* Referral content */}
        {!loading && isAuthenticated && (
          <>
            {/* Progress toward reward — single accurate stat (the old two
                cards showed the same number). */}
            <div
              style={{
                padding: tokens.spacing[6],
                background: tokens.glass.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: tokens.glass.border.light,
                marginBottom: tokens.spacing[6],
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: tokens.spacing[3],
                  marginBottom: tokens.spacing[3],
                }}
              >
                <div>
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize['3xl'],
                      fontWeight: tokens.typography.fontWeight.bold,
                      fontFamily: 'var(--font-mono, monospace)',
                      color: 'var(--color-accent-primary)',
                    }}
                  >
                    {referralCount}
                  </span>
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      color: tokens.colors.text.secondary,
                      marginLeft: tokens.spacing[2],
                    }}
                  >
                    {t('referralFriendsReferred')}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: rewardEarned
                      ? tokens.typography.fontWeight.semibold
                      : tokens.typography.fontWeight.normal,
                    color: rewardEarned
                      ? tokens.colors.accent.success
                      : tokens.colors.text.tertiary,
                  }}
                >
                  {rewardEarned
                    ? t('referralRewardUnlocked')
                    : `${referralCount}/${REFERRAL_REWARD_THRESHOLD}`}
                </span>
              </div>
              {/* Progress bar */}
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: tokens.glass.bg.medium,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${progress * 100}%`,
                    borderRadius: 3,
                    background: rewardEarned
                      ? tokens.colors.accent.success
                      : 'var(--color-accent-primary)',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </div>

            {/* Referral link */}
            <div
              style={{
                padding: tokens.spacing[6],
                background: tokens.glass.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: tokens.glass.border.light,
                marginBottom: tokens.spacing[6],
              }}
            >
              <h3
                style={{
                  fontSize: tokens.typography.fontSize.md,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  margin: `0 0 ${tokens.spacing[3]}`,
                }}
              >
                {t('referralYourLink')}
              </h3>
              {referral?.referral_code ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      gap: tokens.spacing[2],
                      alignItems: 'center',
                    }}
                  >
                    <div
                      style={{
                        flex: 1,
                        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                        background: tokens.colors.bg.tertiary,
                        borderRadius: tokens.radius.md,
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: tokens.typography.fontSize.sm,
                        color: tokens.colors.text.secondary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {referral.referral_link}
                    </div>
                    <button
                      onClick={handleCopy}
                      style={{
                        padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                        borderRadius: tokens.radius.md,
                        border: 'none',
                        background: copied
                          ? tokens.colors.accent.success
                          : 'var(--color-accent-primary)',
                        color: tokens.colors.white,
                        fontSize: tokens.typography.fontSize.sm,
                        fontWeight: tokens.typography.fontWeight.semibold,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        transition: `background ${tokens.transition.fast}`,
                      }}
                    >
                      {copied ? t('copied') : t('copy')}
                    </button>
                  </div>

                  {/* Regenerate */}
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    style={{
                      marginTop: tokens.spacing[3],
                      padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                      borderRadius: tokens.radius.sm,
                      border: tokens.glass.border.light,
                      background: 'transparent',
                      color: tokens.colors.text.tertiary,
                      fontSize: tokens.typography.fontSize.xs,
                      cursor: generating ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {generating ? t('referralGenerating') : t('referralRegenerate')}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  style={{
                    padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                    borderRadius: tokens.radius.md,
                    border: 'none',
                    background: 'var(--color-accent-primary)',
                    color: tokens.colors.white,
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    cursor: generating ? 'not-allowed' : 'pointer',
                  }}
                >
                  {generating ? t('referralGenerating') : t('referralGenerate')}
                </button>
              )}
            </div>

            {/* Share buttons */}
            {referral?.referral_link && (
              <div
                style={{
                  padding: tokens.spacing[6],
                  background: tokens.glass.bg.secondary,
                  borderRadius: tokens.radius.lg,
                  border: tokens.glass.border.light,
                }}
              >
                <h3
                  style={{
                    fontSize: tokens.typography.fontSize.md,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    margin: `0 0 ${tokens.spacing[3]}`,
                  }}
                >
                  {t('share')}
                </h3>
                <div style={{ display: 'flex', gap: tokens.spacing[3], flexWrap: 'wrap' }}>
                  <a
                    href={`https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={shareBtnStyle}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                    Twitter / X
                  </a>
                  <a
                    href={`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={shareBtnStyle}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                    </svg>
                    Telegram
                  </a>
                  <a
                    href={`mailto:?subject=${encodeURIComponent(t('referralShareEmailSubject'))}&body=${encodeURIComponent(shareText + '\n\n' + shareUrl)}`}
                    style={shareBtnStyle}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="M22 7l-10 7L2 7" />
                    </svg>
                    Email
                  </a>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <FloatingActionButton />
    </div>
  )
}

const shareBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: tokens.spacing[2],
  padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
  borderRadius: tokens.radius.md,
  border: `1px solid ${tokens.colors.border.primary}`,
  background: tokens.colors.bg.secondary,
  color: tokens.colors.text.secondary,
  fontSize: tokens.typography.fontSize.sm,
  fontWeight: tokens.typography.fontWeight.medium,
  textDecoration: 'none',
  cursor: 'pointer',
  transition: `border-color ${tokens.transition.fast}`,
}
