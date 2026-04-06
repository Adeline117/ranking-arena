'use client'

import { supabase } from '@/lib/supabase/client'
import dynamic from 'next/dynamic'

const OneClickWalletButton = dynamic(() => import('@/lib/web3/wallet-components').then(m => ({ default: m.OneClickWalletButton })), { ssr: false })
const LazyWeb3Boundary = dynamic(() => import('@/lib/web3/wallet-components').then(m => ({ default: m.Web3Boundary })), { ssr: false })
const PrivyLoginButton = dynamic(() => import('@/app/components/auth/PrivyLoginButton'), { ssr: false })

interface SocialLoginProps {
  lang: string
  searchParams: URLSearchParams
  isAddAccount: boolean
  onError: (msg: string) => void
  onWalletSuccess: (result: { handle?: string | null }) => void
  t: (key: string) => string
}

export default function SocialLogin({ lang, searchParams, isAddAccount, onError, onWalletSuccess: _onWalletSuccess, t: _t }: SocialLoginProps) {
  const getOAuthHandler = (provider: 'google' | 'twitter' | 'discord', providerLabel: string) => async () => {
    onError('')
    const returnUrl = searchParams.get('returnUrl') || searchParams.get('redirect') || ''
    const addAccountParam = isAddAccount ? 'addAccount=true' : ''
    const params = [
      returnUrl ? `returnUrl=${encodeURIComponent(returnUrl)}` : '',
      addAccountParam,
    ].filter(Boolean).join('&')
    const callbackUrl = params
      ? `${window.location.origin}/auth/callback?${params}`
      : `${window.location.origin}/auth/callback`
    const ua = navigator.userAgent || ''
    const isInAppBrowser = /Telegram|TelegramBot|FBAN|FBAV|Instagram|Line\/|WeChat|MicroMessenger/i.test(ua)
    if (isInAppBrowser) {
      const oauthUrl = `${window.location.origin}/login${returnUrl ? '?returnUrl=' + encodeURIComponent(returnUrl) : ''}`
      try { await navigator.clipboard.writeText(oauthUrl) } catch { /* clipboard may not be available */ }
      onError(lang === 'zh'
        ? `请在系统浏览器(Safari/Chrome)中打开此页面登录${providerLabel}。链接已复制到剪贴板。`
        : `Please open this page in your system browser (Safari/Chrome) to sign in with ${providerLabel}. Link copied to clipboard.`)
      window.open(oauthUrl, '_system')
      return
    }
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: callbackUrl },
    })
    if (oauthError) onError(oauthError.message)
  }

  // This component is now rendered at the BOTTOM of the login page (below email form)
  // Social buttons are compact and secondary
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Google - primary social option, slightly larger */}
      <button
        onClick={getOAuthHandler('google', 'Google')}
        className="login-button"
        style={{
          width: '100%',
          padding: '10px 16px',
          borderRadius: 10,
          border: '1px solid var(--glass-border-light)',
          background: 'transparent',
          color: 'var(--color-text-secondary)',
          fontWeight: 600,
          fontSize: 13,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="var(--color-chart-blue)"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="var(--color-accent-success)"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="var(--color-accent-warning)"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="var(--color-accent-error)"/>
        </svg>
        Google
      </button>

      {/* X + Discord in a row */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={getOAuthHandler('twitter', 'X')}
          className="login-button"
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid var(--glass-border-light)',
            background: 'transparent',
            color: 'var(--color-text-secondary)',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
          X
        </button>

        <button
          onClick={getOAuthHandler('discord', 'Discord')}
          className="login-button"
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid var(--glass-border-light)',
            background: 'transparent',
            color: 'var(--color-text-secondary)',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
          Discord
        </button>
      </div>

      {/* Privy One-Click Login - compact */}
      <PrivyLoginButton
        redirectUrl={searchParams.get('returnUrl') || searchParams.get('redirect') || undefined}
        onError={(msg) => onError(msg)}
      />
    </div>
  )
}

export function WalletLogin({ onSuccess, t: _t }: { onSuccess: (result: { handle?: string | null }) => void; t: (key: string) => string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <LazyWeb3Boundary>
        <OneClickWalletButton
          fullWidth
          size="md"
          onSuccess={(result) => {
            onSuccess(result)
          }}
        />
      </LazyWeb3Boundary>
    </div>
  )
}
