'use client'

import React, { useState, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'text' | 'success' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  loading?: boolean
  icon?: React.ReactNode
  iconPosition?: 'left' | 'right'
}

export default function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  loading = false,
  icon,
  iconPosition = 'left',
  style,
  children,
  ...props
}: ButtonProps) {
  const [isPressed, setIsPressed] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [ripple, setRipple] = useState<{ x: number; y: number; key: number } | null>(null)
  const rippleTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // 创建波纹效果
  const createRipple = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    // Clear any existing timeout to prevent old ripple from being cleared prematurely
    if (rippleTimeoutRef.current) {
      clearTimeout(rippleTimeoutRef.current)
    }

    const rect = e.currentTarget.getBoundingClientRect()
    setRipple({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      key: Date.now(), // Unique key for each ripple
    })

    rippleTimeoutRef.current = setTimeout(() => {
      setRipple(null)
      rippleTimeoutRef.current = null
    }, 600)
  }, [])

  const isDisabled = props.disabled || loading

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing[2],
    border: 'none',
    borderRadius: tokens.radius.lg,
    fontWeight: tokens.typography.fontWeight.bold,
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    transition: tokens.transition.all,
    fontFamily: tokens.typography.fontFamily.sans.join(', '),
    position: 'relative',
    overflow: 'hidden',
    transform: isPressed && !isDisabled ? 'scale(0.97)' : isHovered && !isDisabled ? 'translateY(-2px)' : 'scale(1)',
    ...(fullWidth && { width: '100%' }),
  }

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      background: tokens.gradient.primary,
      color: '#FFFFFF',
      border: 'none',
      boxShadow: `0 4px 12px ${tokens.colors.accent?.primary || '#8b6fa8'}40`,
    },
    secondary: {
      background: tokens.glass.bg.light,
      backdropFilter: tokens.glass.blur.sm,
      WebkitBackdropFilter: tokens.glass.blur.sm,
      color: tokens.colors.text.primary,
      border: tokens.glass.border.light,
      boxShadow: tokens.shadow.sm,
    },
    ghost: {
      background: 'transparent',
      color: tokens.colors.text.primary,
      border: `1px solid ${tokens.colors.border.primary}`,
    },
    text: {
      background: 'transparent',
      color: tokens.colors.accent.primary,
      border: 'none',
    },
    success: {
      background: tokens.gradient.success,
      color: '#FFFFFF',
      border: 'none',
      boxShadow: `0 4px 12px ${tokens.colors.accent.success}40`,
    },
    danger: {
      background: tokens.gradient.error,
      color: '#FFFFFF',
      border: 'none',
      boxShadow: `0 4px 12px ${tokens.colors.accent.error}40`,
    },
  }

  const sizeStyles: Record<typeof size, React.CSSProperties> = {
    sm: {
      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
      fontSize: tokens.typography.fontSize.sm,
      minHeight: '36px', // 移动端最小触摸目标
    },
    md: {
      padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
      fontSize: tokens.typography.fontSize.base,
      minHeight: '44px', // 移动端最小触摸目标
    },
    lg: {
      padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
      fontSize: tokens.typography.fontSize.md,
      minHeight: '48px', // 移动端最小触摸目标
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

  const getHoverShadow = () => {
    switch (variant) {
      case 'primary': return tokens.shadow.glow
      case 'success': return tokens.shadow.glowSuccess
      case 'danger': return tokens.shadow.glowError
      default: return tokens.shadow.md
    }
  }
  
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
          setIsHovered(true)
          e.currentTarget.style.boxShadow = getHoverShadow()
          if (variant === 'primary') {
            e.currentTarget.style.background = tokens.gradient.primaryHover
          }
        }
      }}
      onMouseLeave={(e) => {
        if (!isDisabled) {
          setIsHovered(false)
          e.currentTarget.style.transform = 'translateY(0)'
          e.currentTarget.style.boxShadow = variantStyles[variant]?.boxShadow?.toString() || tokens.shadow.xs
          if (variant === 'primary') {
            e.currentTarget.style.background = tokens.gradient.primary
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
          key={ripple.key}
          style={{
            position: 'absolute',
            left: ripple.x,
            top: ripple.y,
            width: 8,
            height: 8,
            background: 'rgba(255, 255, 255, 0.5)',
            borderRadius: '50%',
            transform: 'translate(-50%, -50%)',
            animation: 'ripple 0.6s ease-out forwards',
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
            borderRadius: 'inherit',
          }}
        >
          <span
            className="spinner-sm"
            style={{
              borderColor: 'rgba(255, 255, 255, 0.3)',
              borderTopColor: 'currentColor',
            }}
          />
        </span>
      )}
      
      {/* 内容 - 加载时隐藏但保留空间 */}
      <span style={{ 
        opacity: loading ? 0 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        flexDirection: iconPosition === 'right' ? 'row-reverse' : 'row',
      }}>
        {icon && <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>}
        {children}
      </span>
    </button>
  )
}

