'use client'

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'

/* ── Module-level style constants ──
   Avoids recreating these static objects on every Button render. */

const BTN_BASE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: tokens.spacing[2],
  border: 'none',
  borderRadius: tokens.radius.lg,
  fontWeight: tokens.typography.fontWeight.bold,
  fontFamily: tokens.typography.fontFamily.sans.join(', '),
  position: 'relative',
  overflow: 'hidden',
}

const BTN_VARIANT_STYLES: Record<string, React.CSSProperties> = {
  primary: {
    background: tokens.gradient.primary,
    color: tokens.colors.white,
    border: 'none',
    boxShadow: `0 4px 12px ${tokens.colors.accent.brand}40`,
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
    color: tokens.colors.white,
    border: 'none',
    boxShadow: `0 4px 12px ${tokens.colors.accent.success}40`,
  },
  danger: {
    background: tokens.gradient.error,
    color: tokens.colors.white,
    border: 'none',
    boxShadow: `0 4px 12px ${tokens.colors.accent.error}40`,
  },
}

const BTN_SIZE_STYLES: Record<string, React.CSSProperties> = {
  sm: {
    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
    fontSize: tokens.typography.fontSize.sm,
    minHeight: tokens.spacing[10],
  },
  md: {
    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
    fontSize: tokens.typography.fontSize.base,
    minHeight: `${tokens.touchTarget.min}px`,
  },
  lg: {
    padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
    fontSize: tokens.typography.fontSize.md,
    minHeight: `${tokens.touchTarget.comfortable}px`,
  },
}

const BTN_LOADING_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  inset: 0,
  background: 'inherit',
  borderRadius: 'inherit',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'text' | 'success' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  loading?: boolean
  error?: boolean | string  // true for error state, or error message string
  icon?: React.ReactNode
  iconPosition?: 'left' | 'right'
}

export default function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  loading = false,
  error = false,
  icon,
  iconPosition = 'left',
  style,
  className,
  children,
  ...props
}: ButtonProps) {
  const [ripple, setRipple] = useState<{ x: number; y: number; key: number } | null>(null)
  const rippleTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Cleanup ripple timeout on unmount
  useEffect(() => {
    return () => {
      if (rippleTimeoutRef.current) clearTimeout(rippleTimeoutRef.current)
    }
  }, [])

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
  const hasError = Boolean(error)
  const errorMessage = typeof error === 'string' ? error : undefined

  const baseStyle: React.CSSProperties = {
    ...BTN_BASE_STYLE,
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    ...(fullWidth && { width: '100%' }),
  }

  // 自动生成aria-label（如果未提供）
  const ariaLabel = props['aria-label'] || (typeof children === 'string' ? children : undefined) || 'Button'

  // Error state styles
  const errorStyles: React.CSSProperties = hasError ? {
    borderColor: tokens.colors.accent.error,
    boxShadow: `0 0 0 2px ${tokens.colors.accent.error}30`,
    animation: 'shake 0.5s ease-in-out',
  } : {}

  // Build CSS class string: btn-base handles transition, hover, and active via CSS
  const btnClassName = [
    'btn-base',
    `btn-${variant}`,
    hasError && 'btn-error',
    className,
  ].filter(Boolean).join(' ')

  return (
    <button
      className={btnClassName}
      style={{
        ...baseStyle,
        ...BTN_VARIANT_STYLES[variant],
        ...BTN_SIZE_STYLES[size],
        ...errorStyles,
        ...style,
      }}
      onMouseDown={(e) => {
        if (!isDisabled) {
          createRipple(e)
        }
        props.onMouseDown?.(e)
      }}
      onKeyDown={(e) => {
        // 键盘导航支持：Enter和Space触发点击
        if ((e.key === 'Enter' || e.key === ' ') && !isDisabled) {
          e.preventDefault()
          e.currentTarget.click()
        }
        props.onKeyDown?.(e)
      }}
      aria-label={ariaLabel}
      aria-busy={loading}
      aria-invalid={hasError}
      aria-errormessage={errorMessage}
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
            background: 'var(--glass-border-heavy)',
            borderRadius: '50%',
            transform: 'translate(-50%, -50%)',
            animation: 'ripple 0.6s ease-out forwards',
            pointerEvents: 'none',
          }}
        />
      )}
      
      {/* 加载状态 */}
      {loading && (
        <span style={BTN_LOADING_OVERLAY_STYLE}>
          <span
            className="spinner-sm"
            style={{
              borderColor: 'var(--glass-border-heavy)',
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

