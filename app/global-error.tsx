'use client'

/**
 * 全局错误处理页面
 * 捕获整个应用的未处理错误并上报到 Sentry
 */

import { useEffect, useState } from 'react'
import { t } from '@/lib/i18n'
import { tokens } from '@/lib/design-tokens'

const ARENA_PURPLE = 'var(--color-brand, #8b6fa8)'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [isRetrying, setIsRetrying] = useState(false)

  useEffect(() => {
    // 动态加载 Sentry 上报错误（避免静态 import 增加 bundle）
    import('@sentry/nextjs').then(Sentry => {
      Sentry.captureException(error, {
        tags: {
          errorType: 'global',
          digest: error.digest,
        },
      })
    }).catch(() => { // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
      // Sentry 加载失败时静默处理
    })
  }, [error])

  const handleRetry = () => {
    setIsRetrying(true)
    setTimeout(() => {
      reset()
    }, 300)
  }

  return (
    <html>
      <head>
        <style>{`
          @keyframes iconShake {
            0%, 100% { transform: rotate(0deg); }
            10%, 30%, 50%, 70%, 90% { transform: rotate(-5deg); }
            20%, 40%, 60%, 80% { transform: rotate(5deg); }
          }
          
          @keyframes pulseRing {
            0% { transform: scale(1); opacity: 0.3; }
            50% { transform: scale(1.15); opacity: 0.1; }
            100% { transform: scale(1); opacity: 0.3; }
          }
          
          @keyframes fadeInUp {
            from { 
              opacity: 0; 
              transform: translateY(20px); 
            }
            to { 
              opacity: 1; 
              transform: translateY(0); 
            }
          }
          
          @keyframes floatParticle {
            0%, 100% { transform: translateY(0) scale(1); opacity: 0.2; }
            50% { transform: translateY(-20px) scale(1.1); opacity: 0.4; }
          }
          
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          
          @keyframes glowPulse {
            0%, 100% { box-shadow: 0 0 30px var(--color-accent-error-20); }
            50% { box-shadow: 0 0 50px var(--color-accent-error-20); }
          }
          
          .global-error-bg {
            position: fixed;
            inset: 0;
            background: linear-gradient(135deg, var(--color-bg-primary, #0a0a0f) 0%, #140d14 50%, #0f0d14 100%);
            z-index: 0;
          }
          
          .error-glow {
            position: absolute;
            width: 500px;
            height: 500px;
            border-radius: 50%;
            background: radial-gradient(circle, var(--color-accent-error-10) 0%, transparent 70%);
            top: 40%;
            left: 50%;
            transform: translate(-50%, -50%);
            filter: blur(60px);
            animation: pulseRing 4s ease-in-out infinite;
          }
          
          .error-icon-container {
            animation: iconShake 0.6s ease-in-out;
          }
          
          .error-icon-ring {
            position: absolute;
            inset: -10px;
            border-radius: 50%;
            border: 2px solid var(--color-accent-error-15);
            animation: pulseRing 3s ease-in-out infinite;
          }
          
          .content-section {
            animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            opacity: 0;
          }
          
          .floating-particle {
            position: absolute;
            border-radius: 50%;
            animation: floatParticle ease-in-out infinite;
          }
          
          .retry-button {
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            animation: glowPulse 3s ease infinite;
          }
          
          .retry-button:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 30px var(--color-accent-primary-40);
          }
          
          .retry-button:active {
            transform: translateY(0) scale(0.98);
          }
        `}</style>
      </head>
      <body style={{ margin: 0 }}>
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.5rem',
            color: 'var(--color-text-primary, #EDEDED)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Background */}
          <div className="global-error-bg" />
          
          {/* Glow effect */}
          <div className="error-glow" />
          
          {/* Floating particles */}
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="floating-particle"
              style={{
                width: 6 + i * 2,
                height: 6 + i * 2,
                background: i % 2 === 0 
                  ? 'var(--color-accent-error-20)' 
                  : 'var(--color-accent-primary-30)',
                left: `${20 + i * 15}%`,
                top: `${25 + (i % 3) * 20}%`,
                animationDuration: `${4 + i * 0.8}s`,
                animationDelay: `${i * 0.3}s`,
              }}
            />
          ))}

          {/* Main content */}
          <div
            style={{
              maxWidth: '460px',
              textAlign: 'center',
              padding: '44px 40px',
              borderRadius: '24px',
              background: 'var(--color-backdrop-heavy)',
              border: '1px solid var(--color-accent-error-10)',
              backdropFilter: tokens.glass.blur.lg,
              WebkitBackdropFilter: tokens.glass.blur.lg,
              position: 'relative',
              zIndex: 1,
              boxShadow: '0 25px 50px -12px var(--color-overlay-dark)',
            }}
          >
            {/* Error icon */}
            <div
              className="error-icon-container"
              style={{
                width: 80,
                height: 80,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--color-accent-error-15) 0%, var(--color-accent-error-04) 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 24px',
                position: 'relative',
              }}
            >
              <div className="error-icon-ring" />
              <svg 
                width="40" 
                height="40" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="var(--color-accent-error, #ff7c7c)" 
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>

            {/* Title */}
            <h1
              className="content-section"
              style={{
                fontSize: '1.75rem',
                fontWeight: 700,
                marginBottom: '0.75rem',
                background: `linear-gradient(135deg, var(--color-accent-error, #ff7c7c) 0%, ${ARENA_PURPLE} 100%)`,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                animationDelay: '0.1s',
              }}
            >
              {t('globalErrorTitle')}
            </h1>
            
            {/* Description */}
            <p
              className="content-section"
              style={{
                fontSize: '0.9rem',
                color: 'var(--color-text-secondary)',
                marginBottom: '0.5rem',
                lineHeight: 1.6,
                animationDelay: '0.2s',
              }}
            >
              {t('globalErrorDesc')}
            </p>
            <p
              className="content-section"
              style={{
                fontSize: '0.85rem',
                color: 'var(--color-text-tertiary, #6a6a6a)',
                marginBottom: '1.25rem',
                animationDelay: '0.25s',
              }}
            >
              {t('globalErrorReported')}
            </p>
            
            {/* Error digest */}
            {error.digest && (
              <div
                className="content-section"
                style={{
                  marginBottom: '1.5rem',
                  animationDelay: '0.3s',
                }}
              >
                <span
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--color-accent-error)',
                    fontFamily: '"SF Mono", Consolas, monospace',
                    padding: '6px 12px',
                    background: 'var(--color-accent-error-10)',
                    borderRadius: '6px',
                    border: '1px solid var(--color-accent-error-15)',
                  }}
                >
                  {t('globalErrorId')}: {error.digest}
                </span>
              </div>
            )}

            {/* Retry button */}
            <button
              onClick={handleRetry}
              disabled={isRetrying}
              className="retry-button"
              style={{
                padding: '14px 32px',
                fontSize: '0.95rem',
                fontWeight: 600,
                color: 'var(--color-text-primary, #EDEDED)',
                background: `linear-gradient(135deg, ${ARENA_PURPLE} 0%, var(--color-brand-deep) 100%)`,
                border: 'none',
                borderRadius: tokens.radius.lg,
                cursor: isRetrying ? 'wait' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                opacity: isRetrying ? 0.7 : 1,
              }}
            >
              {isRetrying ? (
                <>
                  <div style={{
                    width: 16,
                    height: 16,
                    border: '2px solid var(--glass-border-heavy)',
                    borderTopColor: 'var(--foreground)',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                  }} />
                  {t('globalErrorRetrying')}
                </>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                  </svg>
                  {t('globalErrorReload')}
                </>
              )}
            </button>

            {/* Back to Home link */}
            <a
              href="/"
              className="content-section"
              style={{
                display: 'inline-block',
                marginTop: '16px',
                fontSize: '0.85rem',
                color: 'var(--color-text-secondary)',
                textDecoration: 'underline',
                textUnderlineOffset: '3px',
                animationDelay: '0.35s',
              }}
            >
              {t('backToHome')}
            </a>

            {/* Help text */}
            <p
              className="content-section"
              style={{
                fontSize: '0.75rem',
                color: 'var(--color-text-tertiary, #5a5a5a)',
                marginTop: '12px',
                animationDelay: '0.4s',
              }}
            >
              {t('errorPersist')}
            </p>
          </div>
        </div>
      </body>
    </html>
  )
}
