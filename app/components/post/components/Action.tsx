'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'

interface ActionProps {
  icon?: React.ReactNode
  text: string
  onClick: (e?: React.MouseEvent) => void
  active?: boolean
  count?: number
  showCount?: boolean
}

/**
 * Action button for post interactions (like, comment, bookmark, share)
 * Provides visual feedback with press and animation states
 */
export function Action({
  icon,
  text,
  onClick,
  active = false,
  count,
  showCount = true,
}: ActionProps) {
  const [isPressed, setIsPressed] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsAnimating(true)
    setTimeout(() => setIsAnimating(false), 300)
    onClick(e)
  }

  return (
    <button
      onClick={handleClick}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      style={{
        border: 'none',
        background: active ? 'rgba(139, 111, 168, 0.15)' : 'transparent',
        color: active ? tokens.colors.accent.brand : tokens.colors.interactive.inactive,
        cursor: 'pointer',
        padding: '6px 12px',
        fontSize: 13,
        fontWeight: active ? 950 : 700,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderRadius: 8,
        transition: 'all 0.2s ease',
        transform: isPressed ? 'scale(0.95)' : 'scale(1)',
        boxShadow: active ? '0 0 0 1px rgba(139, 111, 168, 0.3)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
          e.currentTarget.style.color = tokens.colors.interactive.hover
        }
      }}
      onMouseLeave={(e) => {
        setIsPressed(false)
        if (!active) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = tokens.colors.interactive.inactive
        }
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          transition: 'transform 0.2s ease',
          transform: active ? 'scale(1.1)' : isAnimating ? 'scale(1.2)' : 'scale(1)',
        }}
      >
        {icon}
      </span>
      {text}
      {showCount && count !== undefined && ` ${count}`}
    </button>
  )
}
