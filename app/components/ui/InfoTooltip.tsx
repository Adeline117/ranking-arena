'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'

interface InfoTooltipProps {
  /** Tooltip text content */
  text: string
  /** Icon size in px (default 12) */
  size?: number
}

/**
 * InfoTooltip — ℹ️ icon with styled tooltip.
 * Desktop: hover to show. Mobile: tap to toggle.
 * Uses portal to escape overflow:hidden containers.
 */
export default function InfoTooltip({ text, size = 12 }: InfoTooltipProps) {
  const [show, setShow] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const [ready, setReady] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(null)

  const position = useCallback(() => {
    if (!ref.current || !tooltipRef.current) return
    const r = ref.current.getBoundingClientRect()
    const t = tooltipRef.current.getBoundingClientRect()
    // Prefer above, fallback below
    let top = r.top - t.height - 8
    if (top < 8) top = r.bottom + 8
    // Center horizontally, clamp to viewport
    let left = r.left + r.width / 2 - t.width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8))
    setPos({ top, left })
    setReady(true)
  }, [])

  useEffect(() => {
    if (show) {
      setReady(false)
      requestAnimationFrame(position)
    }
  }, [show, position])

  // Close on outside click (mobile)
  useEffect(() => {
    if (!show) return
    const handler = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      if (tooltipRef.current?.contains(e.target as Node)) return
      setShow(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [show])

  const handleMouseEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setShow(true)
  }
  const handleMouseLeave = () => {
    hideTimer.current = setTimeout(() => setShow(false), 150)
  }
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setShow(prev => !prev)
  }

  const tooltip = show && typeof document !== 'undefined' ? createPortal(
    <div
      ref={tooltipRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        visibility: ready ? 'visible' : 'hidden',
        maxWidth: 260,
        padding: '8px 12px',
        background: tokens.colors.bg.primary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        boxShadow: tokens.shadow.lg,
        zIndex: tokens.zIndex.tooltip,
        fontSize: tokens.typography.fontSize.xs,
        lineHeight: 1.5,
        color: tokens.colors.text.secondary,
        pointerEvents: 'auto',
        whiteSpace: 'pre-line',
      }}
    >
      {text}
    </div>,
    document.body
  ) : null

  return (
    <>
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        aria-label={text}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShow(v => !v) } }}
        style={{
          cursor: 'help',
          opacity: 0.5,
          fontSize: size,
          lineHeight: 1,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          userSelect: 'none',
          minWidth: 32,
          minHeight: 32,
          justifyContent: 'center',
        }}
      >
        &#9432;
      </span>
      {tooltip}
    </>
  )
}
