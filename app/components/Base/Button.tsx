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
      background: tokens.colors.accent?.primary || tokens.colors.bg.secondary,
      color: tokens.colors.black || tokens.colors.text.primary,
      border: `1px solid ${tokens.colors.border.primary}`,
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
          } else if (variant === 'secondary') {
            e.currentTarget.style.boxShadow = tokens.shadow.sm
          }
        }
      }}
      onMouseLeave={(e) => {
        if (!props.disabled) {
          e.currentTarget.style.transform = 'translateY(0)'
          e.currentTarget.style.boxShadow = variantStyles[variant].boxShadow || tokens.shadow.xs
        }
      }}
      aria-label={props['aria-label'] || (typeof children === 'string' ? children : 'Button')}
      {...props}
    >
      {children}
    </button>
  )
}

