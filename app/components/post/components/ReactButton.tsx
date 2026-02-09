'use client'

import { useState, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'

interface ReactButtonProps {
  onClick: (e: React.MouseEvent) => void
  active: boolean
  icon: React.ReactNode
  count: number
  showCount?: boolean
}

export function ReactButton({
  onClick,
  active,
  icon,
  count,
  showCount = true
}: ReactButtonProps) {
  const [isPressed, setIsPressed] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const processingRef = useRef(false)

  const handleClick = (e: React.MouseEvent) => {
    if (processingRef.current) return
    processingRef.current = true

    e.preventDefault()
    e.stopPropagation()

    setIsAnimating(true)
    setTimeout(() => {
      setIsAnimating(false)
      processingRef.current = false
    }, 300)

    onClick(e)
  }

  return (
    <button
      onClick={handleClick}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      style={{
        background: active ? 'var(--color-accent-primary-15)' : 'transparent',
        border: 'none',
        color: active ? tokens.colors.accent.primary : tokens.colors.text.secondary,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 8px',
        borderRadius: tokens.radius.sm,
        transition: 'all 0.2s ease',
        transform: isPressed ? 'scale(0.9)' : 'scale(1)',
        fontWeight: active ? 900 : 400,
        boxShadow: active ? '0 0 0 1px var(--color-accent-primary-20)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--overlay-hover)'
          e.currentTarget.style.color = 'var(--color-text-primary)'
        }
      }}
      onMouseLeave={(e) => {
        setIsPressed(false)
        if (!active) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = 'var(--color-text-secondary)'
        }
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          transition: 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
          transform: isAnimating ? 'scale(1.5)' : active ? 'scale(1.15)' : 'scale(1)',
        }}
      >
        {icon}
      </span>
      {showCount && count}
    </button>
  )
}
