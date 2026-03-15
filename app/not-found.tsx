'use client'

import Link from "next/link"
import { useEffect, useState } from "react"
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

// Using tokens.colors.accent.brand instead of hardcoded color

// CSS styles
const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('not-found-styles')) return
  
  const style = document.createElement('style')
  style.id = 'not-found-styles'
  style.textContent = `
    @keyframes float404 {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      25% { transform: translateY(-15px) rotate(-2deg); }
      75% { transform: translateY(-8px) rotate(2deg); }
    }
    
    @keyframes glitch {
      0%, 100% { text-shadow: 0 0 60px var(--color-accent-primary-30); }
      20% { text-shadow: -3px 0 var(--color-accent-error), 3px 0 var(--color-accent-primary-60); }
      40% { text-shadow: 3px 0 var(--color-accent-error), -3px 0 var(--color-accent-primary-60); }
      60% { text-shadow: 0 0 60px var(--color-accent-primary-30); }
    }
    
    @keyframes orbitParticle {
      from { transform: rotate(0deg) translateX(120px) rotate(0deg); }
      to { transform: rotate(360deg) translateX(120px) rotate(-360deg); }
    }
    
    @keyframes pulseGlow {
      0%, 100% { opacity: 0.3; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(1.05); }
    }
    
    @keyframes floatUp {
      0%, 100% { transform: translateY(0); opacity: 0.4; }
      50% { transform: translateY(-30px); opacity: 0.8; }
    }
    
    @keyframes fadeInUp {
      from { 
        opacity: 0; 
        transform: translateY(30px); 
      }
      to { 
        opacity: 1; 
        transform: translateY(0); 
      }
    }
    
    @keyframes buttonHover {
      0%, 100% { box-shadow: 0 4px 20px var(--color-accent-primary-30); }
      50% { box-shadow: 0 6px 30px var(--color-accent-primary-60); }
    }
    
    @keyframes lineGrow {
      from { width: 0; opacity: 0; }
      to { width: 100%; opacity: 1; }
    }
    
    .not-found-bg {
      position: fixed;
      inset: 0;
      background: var(--color-bg-primary);
      z-index: 0;
    }
    
    .glow-orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(60px);
      animation: pulseGlow 6s ease-in-out infinite;
    }
    
    .number-404 {
      animation: float404 6s ease-in-out infinite, glitch 8s ease-in-out infinite;
    }
    
    .orbit-container {
      position: absolute;
      width: 240px;
      height: 240px;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
    }
    
    .orbit-particle {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 8px;
      height: 8px;
      margin: -4px 0 0 -4px;
      border-radius: 50%;
      animation: orbitParticle linear infinite;
    }
    
    .floating-element {
      position: absolute;
      animation: floatUp 4s ease-in-out infinite;
    }
    
    .content-section {
      animation: fadeInUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      opacity: 0;
    }
    
    .action-button {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      overflow: hidden;
    }
    
    .action-button::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, var(--glass-border-light) 0%, transparent 50%);
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    
    .action-button:hover::before {
      opacity: 1;
    }
    
    .action-button.primary:hover {
      transform: translateY(-3px);
      animation: buttonHover 2s ease infinite;
    }
    
    .action-button.secondary:hover {
      transform: translateY(-2px);
      border-color: ${tokens.colors.accent.brand} !important;
      color: ${tokens.colors.accent.brand} !important;
      box-shadow: 0 4px 20px var(--color-accent-primary-20);
    }
    
    .decorative-line {
      height: 1px;
      background: linear-gradient(90deg, transparent 0%, var(--color-accent-primary-30) 50%, transparent 100%);
      animation: lineGrow 1.5s ease forwards;
    }
    
    .suggestion-card {
      transition: all 0.3s ease;
      cursor: pointer;
    }
    
    .suggestion-card:hover {
      transform: translateY(-4px);
      background: var(--color-accent-primary-10) !important;
      border-color: var(--color-accent-primary-30) !important;
    }
  `
  document.head.appendChild(style)
}

export default function NotFoundPage() {
  const [mounted, setMounted] = useState(false)
  const { t } = useLanguage()
  
  useEffect(() => {
    injectStyles()
    setMounted(true)
  }, [])
  
  if (!mounted) {
    return (
      <div style={{ 
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
      }} />
    )
  }

  return (
    <>
      {/* Simple header for navigation */}
      <header style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 60,
        background: tokens.glass.bg.primary,
        backdropFilter: tokens.glass.blur.lg,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
      }}>
        <Link href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 24, fontWeight: 800, color: tokens.colors.accent.brand }}>Arena</span>
        </Link>
        <Link href="/search" style={{ 
          padding: '8px 16px', 
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.md,
          textDecoration: 'none',
          color: tokens.colors.text.secondary,
          fontSize: 14,
          fontWeight: 500,
        }}>
          {t('search')}
        </Link>
      </header>
      
      <div style={{ 
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        paddingTop: 84, // Account for fixed header
        paddingBottom: 100, // Account for mobile bottom nav
        color: tokens.colors.text.primary,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        position: 'relative',
        overflow: 'hidden',
      }}>
      {/* Animated background */}
      <div className="not-found-bg" />
      
      {/* Glow orbs */}
      <div 
        className="glow-orb"
        style={{
          width: 400,
          height: 400,
          background: `radial-gradient(circle, var(--color-accent-primary-15) 0%, transparent 70%)`,
          top: '30%',
          left: '40%',
          transform: 'translate(-50%, -50%)',
        }}
      />
      <div 
        className="glow-orb"
        style={{
          width: 300,
          height: 300,
          background: `radial-gradient(circle, var(--color-accent-primary-10) 0%, transparent 70%)`,
          top: '60%',
          left: '60%',
          transform: 'translate(-50%, -50%)',
          animationDelay: '2s',
        }}
      />
      
      {/* Floating geometric elements */}
      {[...Array(6)].map((_, i) => (
        <div
          key={i}
          className="floating-element"
          style={{
            left: `${15 + i * 14}%`,
            top: `${20 + (i % 3) * 25}%`,
            width: 6 + (i % 3) * 4,
            height: 6 + (i % 3) * 4,
            background: `rgba(139, 111, 168, ${0.2 + (i % 3) * 0.1})`,
            borderRadius: i % 2 === 0 ? '50%' : '2px',
            transform: i % 2 === 0 ? 'none' : 'rotate(45deg)',
            animationDelay: `${i * 0.4}s`,
            animationDuration: `${4 + i * 0.5}s`,
          }}
        />
      ))}
      
      {/* Main content */}
      <div style={{ 
        position: 'relative', 
        zIndex: 1,
        textAlign: 'center',
        maxWidth: 500,
      }}>
        {/* 404 Number with orbit effect */}
        <div style={{ position: 'relative', marginBottom: 32 }}>
          {/* Orbiting particles */}
          <div className="orbit-container">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="orbit-particle"
                style={{
                  background: `rgba(139, 111, 168, ${0.4 + i * 0.2})`,
                  animationDuration: `${8 + i * 4}s`,
                  animationDelay: `${i * -2}s`,
                }}
              />
            ))}
          </div>
          
          {/* 404 text */}
          <div 
            className="number-404"
            style={{
              fontSize: 140,
              fontWeight: 900,
              lineHeight: 1.2,
              background: `linear-gradient(135deg, ${tokens.colors.accent.brand} 0%, var(--color-accent-primary-30) 100%)`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              position: 'relative',
              zIndex: 2,
            }}
          >
            404
          </div>
        </div>

        {/* Title */}
        <h1 
          className="content-section"
          style={{ 
            fontSize: tokens.typography.fontSize['2xl'], 
            fontWeight: tokens.typography.fontWeight.bold,
            marginBottom: 12,
            animationDelay: '0.2s',
          }}
        >
          {t('notFoundTitle')}
        </h1>
        
        {/* Description */}
        <p 
          className="content-section"
          style={{ 
            opacity: 0.6, 
            marginBottom: 16,
            fontSize: 16,
            lineHeight: 1.6,
            animationDelay: '0.3s',
          }}
        >
          {t('notFoundDesc')}
        </p>
        
        {/* Decorative line */}
        <div 
          className="decorative-line"
          style={{ 
            maxWidth: 200, 
            margin: '24px auto',
          }}
        />

        {/* Action buttons */}
        <div 
          className="content-section"
          style={{ 
            display: 'flex', 
            gap: 14, 
            flexWrap: 'wrap', 
            justifyContent: 'center',
            marginBottom: 40,
            animationDelay: '0.4s',
          }}
        >
          <Link 
            href="/"
            className="action-button primary"
            style={{ 
              padding: '14px 28px', 
              background: `linear-gradient(135deg, ${tokens.colors.accent.brand} 0%, var(--color-brand-deep) 100%)`,
              color: tokens.colors.white, 
              borderRadius: tokens.radius.lg,
              textDecoration: 'none',
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            {t('backToHome')}
          </Link>
          
          <Link
            href="/rankings"
            className="action-button secondary"
            style={{
              padding: '14px 28px',
              background: 'transparent',
              color: tokens.colors.text.primary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              textDecoration: 'none',
              fontSize: 16,
              fontWeight: 500,
            }}
          >
            {t('leaderboardBreadcrumb')}
          </Link>
        </div>

        {/* Suggestions */}
        <div 
          className="content-section"
          style={{
            animationDelay: '0.5s',
          }}
        >
          <p style={{ 
            fontSize: 13, 
            color: tokens.colors.text.tertiary, 
            marginBottom: 16,
            fontWeight: 500,
          }}>
            {t('notFoundExplore')}
          </p>
          
          <div style={{ 
            display: 'flex', 
            gap: 12, 
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}>
            {[
              { href: '/search', label: t('search'), icon: '⌕' },
              { href: '/hot', label: t('hot'), icon: '🔥' },
              { href: '/groups', label: t('groups'), icon: '👥' },
              { href: '/market', label: t('market'), icon: '◈' },
              { href: '/login', label: t('login'), icon: '→' },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="suggestion-card"
                style={{
                  padding: '10px 18px',
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: 10,
                  textDecoration: 'none',
                  color: tokens.colors.text.secondary,
                  fontSize: 13,
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ opacity: 0.6 }}>{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
      </div>
    </>
  )
}
