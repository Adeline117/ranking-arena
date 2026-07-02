'use client'

/**
 * Privy One-Click Login Button
 *
 * Opens the Privy modal for Google/Email/Wallet login.
 * After success, syncs user to Supabase and redirects.
 */

import { useEffect, useRef, useCallback } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { useRouter } from 'next/navigation'
import { syncPrivyUserToSupabase } from '@/lib/privy/sync-user'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

interface PrivyLoginButtonProps {
  redirectUrl?: string
  onError?: (msg: string) => void
}

export default function PrivyLoginButton({ redirectUrl, onError }: PrivyLoginButtonProps) {
  const { login, authenticated, user, ready } = usePrivy()
  const router = useRouter()
  const { t } = useLanguage()
  const hasRedirected = useRef(false)

  // When user becomes authenticated via Privy, sync and redirect
  useEffect(() => {
    if (!authenticated || !user || hasRedirected.current) return
    hasRedirected.current = true

    const doSync = async () => {
      try {
        const email = user.email?.address || user.google?.email || null
        const wallet = user.wallet?.address || null
        const result = await syncPrivyUserToSupabase({
          privyId: user.id,
          email,
          walletAddress: wallet,
        })

        if (result.isNew) {
          // New users → full /onboarding activation flow, preserving destination
          const dest = redirectUrl || '/'
          router.push(`/onboarding?returnUrl=${encodeURIComponent(dest)}`)
        } else {
          router.push(redirectUrl || '/')
        }
      } catch (err) {
        logger.error('Privy sync error:', err)
        hasRedirected.current = false
        onError?.(t('privyAccountSyncFailed'))
      }
    }

    doSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, user, router, redirectUrl])

  const handleClick = useCallback(() => {
    if (authenticated) return // Already logged in, effect will handle redirect
    try {
      login()
    } catch (err) {
      logger.error('Privy login exception:', err)
      onError?.(t('privyLoginFailed'))
    }
  }, [authenticated, login, onError, t])

  if (!ready) return null

  return (
    <button
      onClick={handleClick}
      className="login-button"
      style={{
        width: '100%',
        padding: '16px 20px',
        borderRadius: 14,
        border: '2px solid var(--color-accent-primary-30)',
        background: 'linear-gradient(135deg, rgba(124,58,237,0.15) 0%, rgba(124,58,237,0.05) 100%)',
        color: 'var(--color-text-primary)',
        fontWeight: 700,
        fontSize: 16,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
      }}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
      {t('privyQuickLogin')}
    </button>
  )
}
