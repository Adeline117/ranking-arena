'use client'

import React, { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'text'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  loading?: boolean
}

export default function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  loading = false,
  style,
  children,
  ...props
}: ButtonProps) {
  const [isPressed, setIsPressed] = useState(false)
  const [ripple, setRipple] = useState<{ x: number; y: number } | null>(null)

  // 创建波纹效果
  const createRipple = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setRipple({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
    setTimeout(() => setRipple(null), 500)
  }, [])

  const isDisabled = props.disabled || loading

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing[2],
    border: 'none',
    borderRadius: tokens.radius.md,
    fontWeight: tokens.typography.fontWeight.semibold,
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    transition: `all ${tokens.transition.base}`,
    fontFamily: tokens.typography.fontFamily.sans.join(', '),
    position: 'relative',
    overflow: 'hidden',
    transform: isPressed && !isDisabled ? 'scale(0.97)' : 'scale(1)',
    ...(fullWidth && { width: '100%' }),
  }

  const variantStyles: Record<typeof variant, React.CSSProperties> = {
    primary: {
      background: tokens.colors.accent?.brand || '#8b6fa8',
      color: '#FFFFFF',
      border: `1px solid ${tokens.colors.accent?.brand || '#8b6fa8'}`,
      boxShadow: tokens.shadow.sm,
    },
    secondary: {
      background: tokens.colors.bg.secondary,
      color: tokens.colors.text.primary,
      border: `1px solid ${tokens.colors.border.primary}`,
      boxShadow: tokens.shadow.xs,
    },
    ghost: {
      background: 'transparent',
      color: tokens.colors.text.primary,
      border: `1px solid ${tokens.colors.border.primary}`,
    },
    text: {
      background: 'transparent',
      color: tokens.colors.text.primary,
      border: 'none',
    },
  }

  const sizeStyles: Record<typeof size, React.CSSProperties> = {
    sm: {
      padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
      fontSize: tokens.typography.fontSize.sm,
    },
    md: {
      padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
      fontSize: tokens.typography.fontSize.base,
    },
    lg: {
      padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
      fontSize: tokens.typography.fontSize.md,
    },
  }

  const disabledStyle: React.CSSProperties = isDisabled
    ? {
        opacity: 0.5,
        cursor: 'not-allowed',
        transform: 'none',
      }
    : {}

  // 自动生成aria-label（如果未提供）
  const ariaLabel = props['aria-label'] || (typeof children === 'string' ? children : undefined) || 'Button'
  
  return (
    <button
      style={{
        ...baseStyle,
        ...variantStyles[variant],
        ...sizeStyles[size],
        ...disabledStyle,
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!isDisabled) {
          e.currentTarget.style.transform = 'translateY(-1px)'
          if (variant === 'primary') {
            e.currentTarget.style.boxShadow = tokens.shadow.md
            e.currentTarget.style.background = tokens.colors.accent?.brandHover || '#9d84b5'
          } else if (variant === 'secondary') {
            e.currentTarget.style.boxShadow = tokens.shadow.sm
          }
        }
      }}
      onMouseLeave={(e) => {
        if (!isDisabled) {
          e.currentTarget.style.transform = 'translateY(0)'
          e.currentTarget.style.boxShadow = variantStyles[variant].boxShadow || tokens.shadow.xs
          if (variant === 'primary') {
            e.currentTarget.style.background = tokens.colors.accent?.brand || '#8b6fa8'
          }
        }
        setIsPressed(false)
      }}
      onMouseDown={(e) => {
        if (!isDisabled) {
          setIsPressed(true)
          createRipple(e)
        }
        props.onMouseDown?.(e)
      }}
      onMouseUp={() => {
        setIsPressed(false)
      }}
      onKeyDown={(e) => {
        // 键盘导航支持：Enter和Space触发点击
        if ((e.key === 'Enter' || e.key === ' ') && !isDisabled) {
          e.preventDefault()
          setIsPressed(true)
          e.currentTarget.click()
        }
        props.onKeyDown?.(e)
      }}
      onKeyUp={() => {
        setIsPressed(false)
      }}
      aria-label={ariaLabel}
      aria-busy={loading}
      role={props.role || 'button'}
      tabIndex={isDisabled ? -1 : 0}
      disabled={isDisabled}
      {...props}
    >
      {/* 波纹效果 */}
      {ripple && (
        <span
          style={{
            position: 'absolute',
            left: ripple.x,
            top: ripple.y,
            width: 4,
            height: 4,
            background: 'rgba(255, 255, 255, 0.4)',
            borderRadius: '50%',
            transform: 'translate(-50%, -50%)',
            animation: 'ripple 0.5s ease-out forwards',
            pointerEvents: 'none',
          }}
        />
      )}
      
      {/* 加载状态 */}
      {loading && (
        <span
          style={{
            position: 'absolute',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            inset: 0,
            background: 'inherit',
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              border: '2px solid transparent',
              borderTopColor: 'currentColor',
              borderRadius: '50%',
              animation: 'spin 0.6s linear infinite',
            }}
          />
        </span>
      )}
      
      {/* 内容 - 加载时隐藏但保留空间 */}
      <span style={{ opacity: loading ? 0 : 1 }}>
        {children}
      </span>
    </button>
  )
}

