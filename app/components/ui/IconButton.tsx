'use client'

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useCapacitorHaptics } from '@/lib/hooks/useCapacitor'

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The icon to display */
  icon: ReactNode
  /** Required aria-label for accessibility */
  'aria-label': string
  /** Button size variant */
  size?: 'sm' | 'md' | 'lg'
  /** Button style variant */
  variant?: 'ghost' | 'outline' | 'solid'
  /** Whether to show haptic feedback on click */
  haptic?: boolean
  /** Loading state */
  loading?: boolean
}

const sizeStyles = {
  sm: { padding: tokens.spacing[1], size: 32 },
  md: { padding: tokens.spacing[2], size: 40 },
  lg: { padding: tokens.spacing[3], size: 48 },
}

const variantStyles = {
  ghost: {
    background: 'transparent',
    border: 'none',
    hoverBg: tokens.colors.bg.tertiary,
  },
  outline: {
    background: 'transparent',
    border: `1px solid ${tokens.colors.border.primary}`,
    hoverBg: tokens.colors.bg.tertiary,
  },
  solid: {
    background: tokens.colors.bg.secondary,
    border: 'none',
    hoverBg: tokens.colors.bg.tertiary,
  },
}

/**
 * Accessible icon button with required aria-label
 *
 * Usage:
 *   <IconButton
 *     icon={<SearchIcon />}
 *     aria-label="Search"
 *     onClick={handleSearch}
 *   />
 */
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon,
      'aria-label': ariaLabel,
      size = 'md',
      variant = 'ghost',
      haptic = true,
      loading = false,
      disabled,
      onClick,
      style,
      ...props
    },
    ref
  ) => {
    const { impact } = useCapacitorHaptics()
    const sizeStyle = sizeStyles[size]
    const variantStyle = variantStyles[variant]

    const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
      if (haptic && !disabled && !loading) {
        await impact('light')
      }
      onClick?.(e)
    }

    return (
      <button
        ref={ref}
        type="button"
        aria-label={ariaLabel}
        disabled={disabled || loading}
        onClick={handleClick}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: sizeStyle.size,
          height: sizeStyle.size,
          minWidth: 44, // Minimum touch target
          minHeight: 44,
          padding: sizeStyle.padding,
          borderRadius: tokens.radius.md,
          background: variantStyle.background,
          border: variantStyle.border,
          color: tokens.colors.text.secondary,
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
          opacity: disabled || loading ? 0.5 : 1,
          transition: `all ${tokens.transition.fast}`,
          ...style,
        }}
        {...props}
      >
        {loading ? (
          <span
            style={{
              width: 16,
              height: 16,
              border: '2px solid currentColor',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
            }}
            aria-hidden="true"
          />
        ) : (
          <span aria-hidden="true">{icon}</span>
        )}
      </button>
    )
  }
)

IconButton.displayName = 'IconButton'

export default IconButton
