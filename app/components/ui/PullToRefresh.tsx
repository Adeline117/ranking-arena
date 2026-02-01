'use client'

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface PullToRefreshProps {
  onRefresh: () => Promise<void>
  children: ReactNode
  disabled?: boolean
  threshold?: number
  refreshingText?: string
  pullText?: string
  releaseText?: string
}

/**
 * Pull-to-Refresh component for mobile
 * Wraps content and adds pull-to-refresh functionality
 */
export default function PullToRefresh({
  onRefresh,
  children,
  disabled = false,
  threshold = 80,
  refreshingText: refreshingTextProp,
  pullText: pullTextProp,
  releaseText: releaseTextProp,
}: PullToRefreshProps) {
  const { t } = useLanguage()
  const refreshingText = refreshingTextProp || t('refreshingText')
  const pullText = pullTextProp || t('pullToRefreshText')
  const releaseText = releaseTextProp || t('releaseToRefreshText')
  const [pullDistance, setPullDistance] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isPulling, setIsPulling] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const startYRef = useRef(0)
  const currentYRef = useRef(0)
  const isActiveRef = useRef(false)

  const canPull = useCallback(() => {
    if (disabled || isRefreshing) return false
    // Only allow pull if at top of scroll
    if (containerRef.current) {
      return window.scrollY === 0
    }
    return false
  }, [disabled, isRefreshing])

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!canPull()) return
    startYRef.current = e.touches[0].clientY
    isActiveRef.current = true
  }, [canPull])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isActiveRef.current || !canPull()) return

    currentYRef.current = e.touches[0].clientY
    const distance = currentYRef.current - startYRef.current

    if (distance > 0) {
      // Prevent default scroll when pulling down
      e.preventDefault()
      setIsPulling(true)
      // Apply resistance for a more natural feel
      const resistedDistance = Math.min(distance * 0.5, threshold * 1.5)
      setPullDistance(resistedDistance)
    }
  }, [canPull, threshold])

  const handleTouchEnd = useCallback(async () => {
    if (!isActiveRef.current) return
    isActiveRef.current = false

    if (pullDistance >= threshold && !isRefreshing) {
      setIsRefreshing(true)
      setPullDistance(threshold * 0.6) // Keep indicator visible while refreshing

      try {
        await onRefresh()
      } catch (error) {
        console.error('Refresh failed:', error)
      } finally {
        setIsRefreshing(false)
        setPullDistance(0)
        setIsPulling(false)
      }
    } else {
      setPullDistance(0)
      setIsPulling(false)
    }
  }, [pullDistance, threshold, isRefreshing, onRefresh])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Use passive: false to allow preventDefault
    document.addEventListener('touchstart', handleTouchStart, { passive: true })
    document.addEventListener('touchmove', handleTouchMove, { passive: false })
    document.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      document.removeEventListener('touchstart', handleTouchStart)
      document.removeEventListener('touchmove', handleTouchMove)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [handleTouchStart, handleTouchMove, handleTouchEnd])

  const getIndicatorText = () => {
    if (isRefreshing) return refreshingText
    if (pullDistance >= threshold) return releaseText
    return pullText
  }

  const showIndicator = isPulling || isRefreshing

  return (
    <div ref={containerRef} className="pull-to-refresh-container">
      {/* Pull indicator */}
      <div
        className="pull-to-refresh-indicator"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing[2],
          height: showIndicator ? Math.max(40, pullDistance * 0.8) : 0,
          overflow: 'hidden',
          background: `linear-gradient(180deg, ${tokens.colors.bg.secondary} 0%, transparent 100%)`,
          transition: isRefreshing ? 'none' : 'height 0.2s ease-out',
          pointerEvents: 'none',
        }}
      >
        {/* Spinner */}
        <svg
          width={20}
          height={20}
          viewBox="0 0 24 24"
          fill="none"
          stroke={tokens.colors.accent.primary}
          strokeWidth="2"
          style={{
            transform: isRefreshing ? 'none' : `rotate(${Math.min(pullDistance / threshold, 1) * 360}deg)`,
            transition: 'transform 0.1s ease-out',
            animation: isRefreshing ? 'spin 1s linear infinite' : 'none',
          }}
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
        </svg>

        {/* Text */}
        <span
          style={{
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: tokens.typography.fontWeight.medium,
            color: tokens.colors.text.secondary,
            opacity: Math.min(pullDistance / (threshold * 0.5), 1),
          }}
        >
          {getIndicatorText()}
        </span>
      </div>

      {/* Content with transform */}
      <div
        style={{
          transform: showIndicator ? `translateY(${pullDistance * 0.3}px)` : 'translateY(0)',
          transition: isRefreshing ? 'none' : 'transform 0.2s ease-out',
        }}
      >
        {children}
      </div>

      {/* CSS for spinner animation */}
      <style jsx global>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @media (min-width: 768px) {
          .pull-to-refresh-indicator {
            display: none !important;
          }
        }
      `}</style>
    </div>
  )
}
