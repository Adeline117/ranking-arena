'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import dynamic from 'next/dynamic'
import { injectStyles } from './components/loginHelpers'

const PrivyLoginButton = dynamic(() => import('@/app/components/auth/PrivyLoginButton'), { ssr: false })

export default function LoginPage() {
  const { language: lang, setLanguage: setLang, t } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const searchParams = useSearchParams()

  useEffect(() => {
    injectStyles()
    setMounted(true)
  }, [])

  if (!mounted) return null

  const redirectUrl = searchParams.get('returnUrl') || searchParams.get('redirect') || undefined

  return (
    <div style={{ 
      minHeight: '100vh', 
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div className="login-page-bg" />
      
      {[...Array(6)].map((_, i) => (
        <div
          key={i}
          className="floating-particle"
          style={{
            width: 8 + i * 4,
            height: 8 + i * 4,
            left: `${10 + i * 15}%`,
            top: `${20 + (i % 3) * 25}%`,
            animationDelay: `${i * 0.5}s`,
            animationDuration: `${5 + i}s`,
          }}
        />
      ))}
      
      <div 
        className="login-card"
        style={{ 
          maxWidth: 440, 
          width: '100%',
          background: 'var(--color-bg-secondary, var(--color-backdrop-heavy))',
          border: '1px solid var(--color-accent-primary-15)',
          borderRadius: tokens.radius['3xl'],
          padding: '40px 36px',
          position: 'relative',
          zIndex: 1,
          boxShadow: '0 25px 50px -12px var(--color-overlay-dark), 0 0 80px var(--color-accent-primary-08)',
        }}
      >
        {/* Logo + Language */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="/logo-symbol.svg" alt="arena" width={32} height={32} style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 24, fontWeight: 700, color: tokens.colors.text.primary, letterSpacing: '-0.3px' }}>
              <span style={{ color: 'var(--color-verified-web3)', fontWeight: 800 }}>a</span>rena
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="lang-btn" onClick={() => setLang('zh')} style={{ padding: '8px 14px', borderRadius: 10, border: lang === 'zh' ? '1px solid var(--color-accent-primary-60)' : '1px solid var(--glass-border-light)', background: lang === 'zh' ? 'var(--color-accent-primary-15)' : 'transparent', color: lang === 'zh' ? 'var(--color-brand-accent)' : 'var(--color-text-secondary)', cursor: 'pointer', fontWeight: lang === 'zh' ? 700 : 500, fontSize: 13 }}>
              {t('chinese')}
            </button>
            <button className="lang-btn" onClick={() => setLang('en')} style={{ padding: '8px 14px', borderRadius: 10, border: lang === 'en' ? '1px solid var(--color-accent-primary-60)' : '1px solid var(--glass-border-light)', background: lang === 'en' ? 'var(--color-accent-primary-15)' : 'transparent', color: lang === 'en' ? 'var(--color-brand-accent)' : 'var(--color-text-secondary)', cursor: 'pointer', fontWeight: lang === 'en' ? 700 : 500, fontSize: 13 }}>
              EN
            </button>
          </div>
        </div>

        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ 
            fontSize: tokens.typography.fontSize['2xl'], 
            fontWeight: tokens.typography.fontWeight.extrabold, 
            marginBottom: 8,
            background: 'linear-gradient(135deg, var(--color-text-primary) 0%, var(--color-brand-accent) 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            {t('loginWelcomeBack')}
          </h1>
          <p style={{ fontSize: 14, color: tokens.colors.text.secondary, fontWeight: 500 }}>
            {t('loginSubtitle')}
          </p>
        </div>

        {/* Privy Login - the only login method */}
        <PrivyLoginButton redirectUrl={redirectUrl} />

        {/* Terms */}
        <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 24, lineHeight: 1.6 }}>
          {t('loginTermsNote')}{' '}
          <a href="/terms" style={{ color: 'var(--color-brand)', textDecoration: 'none' }}>{t('termsOfService')}</a>
          {' '}{t('loginTermsAnd')}{' '}
          <a href="/privacy" style={{ color: 'var(--color-brand)', textDecoration: 'none' }}>{t('privacyPolicy')}</a>
        </p>
      </div>
    </div>
  )
}
