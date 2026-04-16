'use client'

import React, { useCallback, useRef, useState } from 'react'
import { t as i18nTFn } from '@/lib/i18n'
import {
  SWIPE_COMPARE_BTN_STYLE,
  SWIPE_SHARE_BTN_STYLE,
  SWIPE_THRESHOLD,
  ACTION_WIDTH,
} from './TraderRowStyles'

export interface TraderRowSwipeActionsProps {
  /** Toggle compare for this trader */
  onCompareToggle: (e: React.MouseEvent) => void
  /** Share URL for this trader */
  shareUrl: string
  /** Display name for share dialog */
  displayName: string
  children: React.ReactNode
}

/**
 * Mobile swipe-to-reveal wrapper that exposes Compare and Share action buttons.
 */
export function TraderRowSwipeActions({
  onCompareToggle,
  shareUrl,
  displayName,
  children,
}: TraderRowSwipeActionsProps) {
  const swipeRef = useRef<{ startX: number; startY: number; swiping: boolean }>({ startX: 0, startY: 0, swiping: false })
  const contentRef = useRef<HTMLDivElement>(null)
  const [swipeOpen, setSwipeOpen] = useState(false)

  const closeSwipe = useCallback(() => {
    const el = contentRef.current
    if (el) {
      el.style.transition = ''
      el.style.transform = 'translateX(0)'
    }
    setSwipeOpen(false)
  }, [])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    swipeRef.current = { startX: touch.clientX, startY: touch.clientY, swiping: false }
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    const dx = touch.clientX - swipeRef.current.startX
    const dy = touch.clientY - swipeRef.current.startY
    if (!swipeRef.current.swiping && Math.abs(dy) > Math.abs(dx)) return
    if (Math.abs(dx) > 10) swipeRef.current.swiping = true
    if (!swipeRef.current.swiping) return
    e.preventDefault()
    const el = contentRef.current
    if (!el) return
    const offset = swipeOpen ? -ACTION_WIDTH + dx : dx
    const clamped = Math.max(-ACTION_WIDTH, Math.min(0, offset))
    el.style.transform = `translateX(${clamped}px)`
    el.style.transition = 'none'
  }, [swipeOpen])

  const handleTouchEnd = useCallback(() => {
    if (!swipeRef.current.swiping) return
    const el = contentRef.current
    if (!el) return
    el.style.transition = ''
    const matrix = getComputedStyle(el).transform
    const tx = matrix !== 'none' ? parseFloat(matrix.split(',')[4]) : 0
    if (tx < -SWIPE_THRESHOLD) {
      el.style.transform = `translateX(-${ACTION_WIDTH}px)`
      setSwipeOpen(true)
    } else {
      el.style.transform = 'translateX(0)'
      setSwipeOpen(false)
    }
  }, [])

  const handleShare = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    closeSwipe()
    if (typeof navigator !== 'undefined' && navigator.share) {
      void navigator.share({ title: displayName, url: shareUrl }).catch(() => {
        navigator.clipboard?.writeText(shareUrl).catch(() => {
          console.warn('[TraderRow] share and clipboard both failed')
        })
      })
    } else if (typeof navigator !== 'undefined') {
      navigator.clipboard.writeText(shareUrl).catch(() => {
        console.warn('[TraderRow] clipboard.writeText failed')
      })
    }
  }, [displayName, shareUrl, closeSwipe])

  return (
    <div
      className="swipe-row-wrapper"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="swipe-row-actions">
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); closeSwipe(); onCompareToggle(e) }}
          style={SWIPE_COMPARE_BTN_STYLE}
          title={i18nTFn('compare')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
          <span>{i18nTFn('compare')}</span>
        </button>
        <button
          onClick={handleShare}
          style={SWIPE_SHARE_BTN_STYLE}
          title={i18nTFn('share')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          <span>{i18nTFn('share')}</span>
        </button>
      </div>

      <div ref={contentRef} className="swipe-row-content">
        {children}
      </div>
    </div>
  )
}
