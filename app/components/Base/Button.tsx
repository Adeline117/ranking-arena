'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'text'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  style,
  children,
  ...props
}: ButtonProps) {
  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing[2],
    border: 'none',
    borderRadius: tokens.radius.md,
    fontWeight: tokens.typography.fontWeight.semibold,
    cursor: props.disabled ? 'not-allowed' : 'pointer',
    transition: `all ${tokens.transition.base}`,
    fontFamily: tokens.typography.fontFamily.sans.join(', '),
    position: 'relative',
    overflow: 'hidden',
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

  const disabledStyle: React.CSSProperties = props.disabled
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
        if (!props.disabled) {
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
        if (!props.disabled) {
          e.currentTarget.style.transform = 'translateY(0)'
          e.currentTarget.style.boxShadow = variantStyles[variant].boxShadow || tokens.shadow.xs
          if (variant === 'primary') {
            e.currentTarget.style.background = tokens.colors.accent?.brand || '#8b6fa8'
          }
        }
      }}
      onKeyDown={(e) => {
        // 键盘导航支持：Enter和Space触发点击
        if ((e.key === 'Enter' || e.key === ' ') && !props.disabled) {
          e.preventDefault()
          e.currentTarget.click()
        }
        props.onKeyDown?.(e)
      }}
      aria-label={ariaLabel}
      role={props.role || 'button'}
      tabIndex={props.disabled ? -1 : 0}
      {...props}
    >
      {children}
    </button>
  )
}

