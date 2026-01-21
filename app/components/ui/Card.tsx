'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

export interface CardProps {
  title?: string
  subtitle?: string
  children: React.ReactNode
  variant?: 'default' | 'glass' | 'outline' | 'elevated'
  padding?: 'sm' | 'md' | 'lg'
  hoverable?: boolean
  accent?: boolean
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
}

export default function Card({ 
  title, 
  subtitle,
  children, 
  variant = 'default',
  padding = 'md',
  hoverable = true,
  accent = false,
  className = '',
  style,
  onClick,
}: CardProps) {
  const paddingValue = {
    sm: 3,
    md: 4,
    lg: 6,
  }[padding] as 3 | 4 | 6

  const getVariantStyles = () => {
    switch (variant) {
      case 'glass':
        return {
          background: tokens.glass.bg.secondary,
          backdropFilter: tokens.glass.blur.lg,
          WebkitBackdropFilter: tokens.glass.blur.lg,
          border: tokens.glass.border.light,
        }
      case 'outline':
        return {
          background: 'transparent',
          border: `1px solid ${tokens.colors.border.primary}`,
        }
      case 'elevated':
        return {
          background: tokens.colors.bg.secondary,
          boxShadow: tokens.shadow.lg,
          border: 'none',
        }
      default:
        return {
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
        }
    }
  }

  const baseClassName = variant === 'glass' ? 'glass-card-hover' : 'card-hover-lift'

  return (
    <Box
      className={`${hoverable ? baseClassName : ''} ${className}`}
      p={paddingValue}
      radius="xl"
      style={{
        ...getVariantStyles(),
        boxShadow: variant !== 'elevated' ? tokens.shadow.sm : tokens.shadow.lg,
        transition: tokens.transition.all,
        cursor: onClick ? 'pointer' : undefined,
        position: 'relative',
        overflow: 'hidden',
        ...style,
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (hoverable) {
          e.currentTarget.style.boxShadow = tokens.shadow.cardHover
          if (variant !== 'glass') {
            e.currentTarget.style.transform = 'translateY(-4px)'
          }
        }
      }}
      onMouseLeave={(e) => {
        if (hoverable) {
          e.currentTarget.style.boxShadow = variant === 'elevated' ? tokens.shadow.lg : tokens.shadow.sm
          e.currentTarget.style.transform = 'translateY(0)'
        }
      }}
    >
      {/* Accent top border */}
      {accent && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: tokens.gradient.primary,
            borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
          }}
        />
      )}
      
      {/* Header */}
      {(title || subtitle) && (
        <div style={{ marginBottom: tokens.spacing[4] }}>
          {title && (
            <Text size="lg" weight="black" style={{ marginBottom: subtitle ? tokens.spacing[1] : 0 }}>
              {title}
            </Text>
          )}
          {subtitle && (
            <Text size="sm" color="tertiary">
              {subtitle}
            </Text>
          )}
        </div>
      )}
      
      {children}
    </Box>
  )
}
