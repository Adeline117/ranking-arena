"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { logger } from '@/lib/logger'

const ARENA_PURPLE = 'var(--color-brand, #8b6fa8)'

// CSS styles
const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('error-page-styles')) return
  
  const style = document.createElement('style')
  style.id = 'error-page-styles'
  style.textContent = `
    @keyframes iconShake {
      0%, 100% { transform: rotate(0deg); }
      10%, 30%, 50%, 70%, 90% { transform: rotate(-5deg); }
      20%, 40%, 60%, 80% { transform: rotate(5deg); }
    }
    
    @keyframes pulseRing {
      0% { transform: scale(1); opacity: 0.3; }
      50% { transform: scale(1.1); opacity: 0.1; }
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
    
    @keyframes glowPulse {
      0%, 100% { box-shadow: 0 0 30px var(--color-accent-error-20); }
      50% { box-shadow: 0 0 50px var(--color-accent-error-20); }
    }
    
    @keyframes floatParticle {
      0%, 100% { transform: translateY(0) scale(1); opacity: 0.3; }
      50% { transform: translateY(-15px) scale(1.1); opacity: 0.6; }
    }
    
    @keyframes lineExpand {
      from { transform: scaleX(0); opacity: 0; }
      to { transform: scaleX(1); opacity: 1; }
    }
    
    .error-page-bg {
      position: fixed;
      inset: 0;
      background: var(--color-bg-primary, linear-gradient(135deg, #0a0a0f 0%, #140d14 50%, #0f0d14 100%));
      z-index: 0;
    }
    
    .error-glow {
      position: absolute;
      width: 500px;
      height: 500px;
      border-radius: 50%;
      background: radial-gradient(circle, var(--color-accent-error-08) 0%, transparent 70%);
      top: 40%;
      left: 50%;
      transform: translate(-50%, -50%);
      filter: blur(40px);
      animation: pulseRing 4s ease-in-out infinite;
    }
    
    .error-icon-container {
      animation: iconShake 0.6s ease-in-out;
    }
    
    .error-icon-ring {
      position: absolute;
      inset: -12px;
      border-radius: 50%;
      border: 2px solid var(--color-accent-error-15);
      animation: pulseRing 3s ease-in-out infinite;
    }
    
    .content-section {
      animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      opacity: 0;
    }
    
    .action-button {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      overflow: hidden;
    }
    
    .action-button::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, var(--glass-border-light) 0%, transparent 50%);
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    
    .action-button:hover::after {
      opacity: 1;
    }
    
    .action-button.primary {
      animation: glowPulse 3s ease infinite;
    }
    
    .action-button.primary:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px var(--color-accent-primary-40);
    }
    
    .action-button.secondary:hover {
      transform: translateY(-2px);
      border-color: ${ARENA_PURPLE} !important;
      color: ${ARENA_PURPLE} !important;
    }
    
    .floating-particle {
      position: absolute;
      border-radius: 50%;
      animation: floatParticle ease-in-out infinite;
    }
    
    .error-code {
      font-family: 'SF Mono', 'Consolas', monospace;
      background: var(--color-accent-error-10);
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--color-accent-error-15);
    }
    
    .decorative-line {
      height: 1px;
      background: linear-gradient(90deg, transparent 0%, var(--color-accent-error-20) 50%, transparent 100%);
      animation: lineExpand 1s ease 0.5s forwards;
      transform: scaleX(0);
    }
    
    .help-card {
      transition: all 0.3s ease;
    }
    
    .help-card:hover {
      transform: translateY(-2px);
      background: var(--color-accent-primary-08) !important;
      border-color: var(--color-accent-primary-20) !important;
    }
  `
  document.head.appendChild(style)
}

// Error page component
export default function Error({ 
  error, 
  reset 
}: { 
  error: Error & { digest?: string }
  reset: () => void 
}) {
  const { t } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)

  useEffect(() => {
    injectStyles()
    setMounted(true)
    logger.error("[Error]", error)
  }, [error])

  const handleRetry = async () => {
    setIsRetrying(true)
    // Small delay for visual feedback
    setTimeout(() => {
      reset()
    }, 300)
  }

  if (!mounted) {
    return (
      <div style={{ 
        minHeight: '100vh',
        background: 'var(--color-bg-primary, #0a0a0f)',
      }} />
    )
  }

  return (
    <div style={{ 
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24, 
      color: 'var(--color-text-primary, #EDEDED)', 
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Background */}
      <div className="error-page-bg" />
      
      {/* Glow effect */}
      <div className="error-glow" />
      
      {/* Floating particles */}
      {[...Array(5)].map((_, i) => (
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
      <div style={{ 
        position: 'relative', 
        zIndex: 1,
        textAlign: 'center',
        maxWidth: 440,
      }}>
        {/* Error icon */}
        <div 
          className="error-icon-container"
          style={{
            width: 90,
            height: 90,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--color-accent-error-15) 0%, var(--color-accent-error-04) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 28px',
            position: 'relative',
          }}
        >
          <div className="error-icon-ring" />
          <svg 
            width="44" 
            height="44" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="var(--color-accent-error, #ff7c7c)" 
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        {/* Title */}
        <h1 
          className="content-section"
          style={{ 
            fontSize: tokens.typography.fontSize['2xl'], 
            fontWeight: tokens.typography.fontWeight.bold,
            marginBottom: 12,
            background: `linear-gradient(135deg, var(--color-text-primary, #EDEDED) 0%, ${ARENA_PURPLE} 100%)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            animationDelay: '0.1s',
          }}
        >
          {t('errorTitle')}
        </h1>
        
        {/* Description */}
        <p 
          className="content-section"
          style={{ 
            opacity: 0.7, 
            marginBottom: 10,
            fontSize: 16,
            lineHeight: 1.6,
            animationDelay: '0.2s',
          }}
        >
          {t('errorMessage')}
        </p>
        <p
          className="content-section"
          style={{
            opacity: 0.5,
            fontSize: 14,
            marginBottom: 16,
            animationDelay: '0.25s',
          }}
        >
          {t('errorRefresh')}
        </p>
        
        {/* Error digest */}
        {error.digest && (
          <div 
            className="content-section"
            style={{ 
              marginBottom: 20,
              animationDelay: '0.3s',
            }}
          >
            <span 
              className="error-code"
              style={{
                fontSize: 12,
                color: 'var(--color-accent-error)',
              }}
            >
              {t('errorCode')}: {error.digest}
            </span>
          </div>
        )}

        {/* Decorative line */}
        <div 
          className="decorative-line"
          style={{ 
            maxWidth: 180, 
            margin: '20px auto',
          }}
        />

        {/* Action buttons */}
        <div 
          className="content-section"
          style={{ 
            display: 'flex', 
            gap: 14,
            justifyContent: 'center',
            marginBottom: 32,
            animationDelay: '0.4s',
          }}
        >
          <button 
            onClick={handleRetry}
            disabled={isRetrying}
            className="action-button primary"
            style={{ 
              padding: '14px 28px', 
              background: `linear-gradient(135deg, ${ARENA_PURPLE} 0%, var(--color-brand-deep) 100%)`,
              color: tokens.colors.white, 
              borderRadius: tokens.radius.lg,
              border: 'none',
              cursor: isRetrying ? 'wait' : 'pointer',
              fontSize: 16,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
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
                {t('retry')}...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                </svg>
                {t('retry')}
              </>
            )}
          </button>
          
          <Link 
            href="/"
            className="action-button secondary"
            style={{ 
              padding: '14px 28px', 
              background: 'transparent',
              color: 'var(--color-text-primary, #EDEDED)', 
              borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-border-primary, var(--glass-border-medium))',
              textDecoration: 'none',
              fontSize: 16,
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
              <polyline points="9 22 9 12 15 12 15 22"></polyline>
            </svg>
            {t('backToHome')}
          </Link>
        </div>

        {/* Error digest + report issue */}
        {error?.digest && (
          <p
            className="content-section"
            style={{
              animationDelay: '0.45s',
              fontSize: 12,
              color: 'var(--color-text-quaternary, #444)',
              fontFamily: 'monospace',
              marginBottom: 8,
            }}
          >
            Error ID: {error.digest}
          </p>
        )}

        <div
          className="content-section"
          style={{
            animationDelay: '0.5s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            fontSize: 13,
            color: 'var(--color-text-tertiary, #5a5a5a)',
          }}
        >
          <span>{t('errorPersist')}</span>
          <a
            href="https://x.com/Arena_English"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: ARENA_PURPLE,
              textDecoration: 'none',
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            {t('reportIssue') || 'Report Issue'}
          </a>
        </div>
      </div>
      
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
