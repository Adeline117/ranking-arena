'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'

interface ReferralData {
  referral_code: string
  referral_count: number
  referral_link: string
}

export default function ReferralClient() {
  const [email, setEmail] = useState<string | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [referral, setReferral] = useState<ReferralData | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setIsAuthenticated(false)
        setLoading(false)
        return
      }
      setIsAuthenticated(true)
      setEmail(user.email ?? null)

      const { data: { session } } = await supabase.auth.getSession()
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
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const res = await fetch('/api/referral', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const json = await res.json()
        setReferral(prev => ({
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
  const shareText = 'Check out Arena - the crypto trader ranking platform!'

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 16px 60px' }}>
        {/* Header */}
        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: '-0.5px' }}>
            Referral Program
          </h1>
          <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginTop: 6 }}>
            Invite friends to Arena and track your referrals.
          </p>
        </div>

        {/* Auth gate */}
        {isAuthenticated === false && (
          <div style={{
            padding: '60px 20px',
            textAlign: 'center',
            background: tokens.glass.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: tokens.glass.border.light,
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, marginBottom: 16 }}>
              <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="8.5" cy="7" r="4" />
              <line x1="20" y1="8" x2="20" y2="14" />
              <line x1="23" y1="11" x2="17" y2="11" />
            </svg>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>
              Sign in to get your referral link
            </h2>
            <p style={{ fontSize: 14, color: tokens.colors.text.secondary, margin: '0 0 20px' }}>
              Create an account or log in to start inviting friends.
            </p>
            <Link
              href="/auth/login"
              style={{
                display: 'inline-block',
                padding: '10px 24px',
                background: 'var(--color-accent-primary)',
                color: '#fff',
                borderRadius: tokens.radius.md,
                fontWeight: 600,
                fontSize: 14,
                textDecoration: 'none',
              }}
            >
              Sign In
            </Link>
          </div>
        )}

        {/* Loading */}
        {loading && isAuthenticated !== false && (
          <LoadingSkeleton variant="card" count={2} />
        )}

        {/* Referral content */}
        {!loading && isAuthenticated && (
          <>
            {/* Stats cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 12,
              marginBottom: 24,
            }}>
              <div style={{
                padding: '24px',
                background: tokens.glass.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: tokens.glass.border.light,
                textAlign: 'center',
              }}>
                <div style={{
                  fontSize: 36,
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono, monospace)',
                  color: 'var(--color-accent-primary)',
                }}>
                  {referral?.referral_count ?? 0}
                </div>
                <div style={{ fontSize: 13, color: tokens.colors.text.secondary, marginTop: 4 }}>
                  Friends Invited
                </div>
              </div>
              <div style={{
                padding: '24px',
                background: tokens.glass.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: tokens.glass.border.light,
                textAlign: 'center',
              }}>
                <div style={{
                  fontSize: 36,
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono, monospace)',
                  color: tokens.colors.accent.success,
                }}>
                  {referral?.referral_count ?? 0}
                </div>
                <div style={{ fontSize: 13, color: tokens.colors.text.secondary, marginTop: 4 }}>
                  Active Referrals
                </div>
              </div>
            </div>

            {/* Referral link */}
            <div style={{
              padding: '24px',
              background: tokens.glass.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: tokens.glass.border.light,
              marginBottom: 24,
            }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>
                Your Referral Link
              </h3>
              {referral?.referral_code ? (
                <>
                  <div style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                  }}>
                    <div style={{
                      flex: 1,
                      padding: '10px 14px',
                      background: tokens.colors.bg.tertiary,
                      borderRadius: tokens.radius.md,
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 13,
                      color: tokens.colors.text.secondary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {referral.referral_link}
                    </div>
                    <button
                      onClick={handleCopy}
                      style={{
                        padding: '10px 20px',
                        borderRadius: tokens.radius.md,
                        border: 'none',
                        background: copied ? tokens.colors.accent.success : 'var(--color-accent-primary)',
                        color: '#fff',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        transition: 'background 0.2s',
                      }}
                    >
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>

                  {/* Regenerate */}
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    style={{
                      marginTop: 12,
                      padding: '6px 14px',
                      borderRadius: tokens.radius.sm,
                      border: tokens.glass.border.light,
                      background: 'transparent',
                      color: tokens.colors.text.tertiary,
                      fontSize: 12,
                      cursor: generating ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {generating ? 'Generating...' : 'Regenerate Code'}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  style={{
                    padding: '12px 24px',
                    borderRadius: tokens.radius.md,
                    border: 'none',
                    background: 'var(--color-accent-primary)',
                    color: '#fff',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: generating ? 'not-allowed' : 'pointer',
                  }}
                >
                  {generating ? 'Generating...' : 'Generate Referral Link'}
                </button>
              )}
            </div>

            {/* Share buttons */}
            {referral?.referral_link && (
              <div style={{
                padding: '24px',
                background: tokens.glass.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: tokens.glass.border.light,
              }}>
                <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>
                  Share
                </h3>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <a
                    href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`}
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
                    href={`mailto:?subject=${encodeURIComponent('Check out Arena')}&body=${encodeURIComponent(shareText + '\n\n' + shareUrl)}`}
                    style={shareBtnStyle}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
  gap: 8,
  padding: '10px 20px',
  borderRadius: '8px',
  border: '1px solid var(--color-border-primary)',
  background: 'var(--color-bg-secondary)',
  color: 'var(--color-text-secondary)',
  fontSize: 13,
  fontWeight: 500,
  textDecoration: 'none',
  cursor: 'pointer',
  transition: 'border-color 0.15s',
}
