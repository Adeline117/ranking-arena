'use client'

export const dynamic = 'force-dynamic'

import Link from "next/link"
import { useEffect, useState } from "react"
import { t } from '@/lib/i18n'
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
      0%, 100% { text-shadow: 0 0 60px rgba(139, 111, 168, 0.3); }
      20% { text-shadow: -3px 0 rgba(255, 124, 124, 0.5), 3px 0 rgba(139, 111, 168, 0.5); }
      40% { text-shadow: 3px 0 rgba(255, 124, 124, 0.5), -3px 0 rgba(139, 111, 168, 0.5); }
      60% { text-shadow: 0 0 60px rgba(139, 111, 168, 0.3); }
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
      0%, 100% { box-shadow: 0 4px 20px rgba(139, 111, 168, 0.3); }
      50% { box-shadow: 0 6px 30px rgba(139, 111, 168, 0.5); }
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
      background: linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 50%);
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
      box-shadow: 0 4px 20px rgba(139, 111, 168, 0.2);
    }
    
    .decorative-line {
      height: 1px;
      background: linear-gradient(90deg, transparent 0%, rgba(139, 111, 168, 0.3) 50%, transparent 100%);
      animation: lineGrow 1.5s ease forwards;
    }
    
    .suggestion-card {
      transition: all 0.3s ease;
      cursor: pointer;
    }
    
    .suggestion-card:hover {
      transform: translateY(-4px);
      background: rgba(139, 111, 168, 0.1) !important;
      border-color: rgba(139, 111, 168, 0.3) !important;
    }
  `
  document.head.appendChild(style)
}

export default function NotFoundPage() {
  const [mounted, setMounted] = useState(false)
  
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
    <div style={{ 
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
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
          background: `radial-gradient(circle, rgba(139, 111, 168, 0.15) 0%, transparent 70%)`,
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
          background: `radial-gradient(circle, rgba(107, 79, 136, 0.1) 0%, transparent 70%)`,
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
              background: `linear-gradient(135deg, ${tokens.colors.accent.brand} 0%, rgba(139, 111, 168, 0.3) 100%)`,
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
              background: `linear-gradient(135deg, ${tokens.colors.accent.brand} 0%, #6b4f88 100%)`,
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
            href="/hot"
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
            {t('notFoundViewHot')}
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
              { href: '/groups', label: t('notFoundBrowseGroups'), icon: '◈' },
              { href: '/search', label: t('search'), icon: '⌕' },
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
  )
}
