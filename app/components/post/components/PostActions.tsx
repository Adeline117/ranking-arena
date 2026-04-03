'use client'

import { useState, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { ARENA_PURPLE } from '@/lib/utils/content'

interface ReactButtonProps {
  onClick: (e: React.MouseEvent) => void | Promise<void>
  active: boolean
  icon: React.ReactNode
  count: number
  showCount?: boolean
}

export function ReactButton({ onClick, active, icon, count, showCount = true }: ReactButtonProps) {
  const [isPressed, setIsPressed] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const processingRef = useRef(false)

  const handleClick = (e: React.MouseEvent) => {
    if (processingRef.current) return
    processingRef.current = true

    e.preventDefault()
    e.stopPropagation()

    setIsAnimating(true)

    // 执行点击回调，支持异步操作
    const result = onClick(e)

    // 动画结束后重置动画状态
    setTimeout(() => {
      setIsAnimating(false)
    }, 300)

    // 如果 onClick 返回 Promise，等待完成后才解锁
    // 否则使用 500ms 作为最小防抖时间
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).finally(() => {
        processingRef.current = false
      })
    } else {
      setTimeout(() => {
        processingRef.current = false
      }, 500)
    }
  }

  return (
    <button
      onClick={handleClick}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      aria-pressed={active}
      style={{
        background: active ? 'var(--color-accent-primary-15)' : 'transparent',
        border: 'none',
        color: active ? tokens.colors.accent.primary : tokens.colors.text.secondary,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '10px 12px',
        borderRadius: tokens.radius.md,
        minHeight: 44,
        transition: `all ${tokens.transition.base}`,
        transform: isPressed ? 'scale(0.9)' : 'scale(1)',
        fontWeight: active ? 900 : 400,
        boxShadow: active ? '0 0 0 1px var(--color-accent-primary-20)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--overlay-hover)'
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
          transition: 'transform 0.2s ease',
          transform: active ? 'scale(1.15)' : isAnimating ? 'scale(1.3)' : 'scale(1)',
        }}
      >
        {icon}
      </span>
      {showCount && count}
    </button>
  )
}

interface ActionProps {
  icon?: React.ReactNode
  text: string
  onClick: (e?: React.MouseEvent) => void | Promise<void>
  active?: boolean
  count?: number
  showCount?: boolean
}

export function Action({ icon, text, onClick, active, count, showCount }: ActionProps) {
  const [isPressed, setIsPressed] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const processingRef = useRef(false)

  const handleClick = async (e: React.MouseEvent) => {
    if (processingRef.current) return
    processingRef.current = true

    e.preventDefault()
    e.stopPropagation()
    setIsAnimating(true)
    try {
      await onClick(e)
    } finally {
      setTimeout(() => {
        setIsAnimating(false)
        processingRef.current = false
      }, 300)
    }
  }

  return (
    <button
      onClick={handleClick}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      aria-pressed={active}
      style={{
        border: 'none',
        background: active ? 'var(--color-accent-primary-15)' : 'transparent',
        color: active ? ARENA_PURPLE : tokens.colors.interactive.inactive,
        cursor: 'pointer',
        padding: '10px 14px',
        fontSize: 13,
        fontWeight: active ? 900 : 600,
        minHeight: 44,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderRadius: tokens.radius.md,
        transition: `all ${tokens.transition.base}`,
        transform: isPressed ? 'scale(0.95)' : 'scale(1)',
        boxShadow: active ? '0 0 0 1px var(--color-accent-primary-30)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--overlay-hover)'
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


