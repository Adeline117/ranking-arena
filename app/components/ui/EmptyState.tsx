'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'

type EmptyStateProps = {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode | { label: string; onClick: () => void }
  variant?: 'default' | 'compact' | 'card'
}

export default function EmptyState({ icon, title, description, action, variant = 'default' }: EmptyStateProps) {
  const isCard = variant === 'card'
  const isCompact = variant === 'compact'
  
  return (
    <Box
      className={isCard ? 'glass-card card-enter' : 'card-enter'}
      style={{
        padding: isCompact 
          ? `${tokens.spacing[8]} ${tokens.spacing[4]}`
          : `${tokens.spacing[16]} ${tokens.spacing[6]}`,
        textAlign: 'center',
        borderRadius: isCard ? tokens.radius.xl : undefined,
        background: isCard ? tokens.glass.bg.light : 'transparent',
        border: isCard ? tokens.glass.border.light : undefined,
      }}
    >
      {/* Icon with gradient background */}
      {icon && (
        <Box 
          style={{ 
            marginBottom: tokens.spacing[4], 
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <Box
            style={{
              width: isCompact ? 56 : 72,
              height: isCompact ? 56 : 72,
              borderRadius: tokens.radius.full,
              background: tokens.gradient.primarySubtle,
              border: `1px solid ${tokens.colors.accent.primary}20`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: isCompact ? tokens.typography.fontSize['2xl'] : tokens.typography.fontSize['3xl'],
            }}
          >
            {icon}
          </Box>
        </Box>
      )}
      
      {/* Title */}
      <Text 
        size={isCompact ? 'sm' : 'md'} 
        weight="black" 
        color="primary" 
        style={{ marginBottom: tokens.spacing[2] }}
      >
        {title}
      </Text>
      
      {/* Description */}
      {description && (
        <Text
          size={isCompact ? 'xs' : 'sm'}
          color="tertiary"
          style={{
            marginBottom: action ? tokens.spacing[5] : 0,
            maxWidth: 360,
            marginLeft: 'auto',
            marginRight: 'auto',
            lineHeight: 1.6,
          }}
        >
          {description}
        </Text>
      )}
      
      {/* Action */}
      {action && (
        <Box style={{ marginTop: tokens.spacing[4] }}>
          {typeof action === 'object' && action !== null && 'label' in action && 'onClick' in action ? (
            <Button variant="secondary" size="sm" onClick={(action as { label: string; onClick: () => void }).onClick}>
              {(action as { label: string; onClick: () => void }).label}
            </Button>
          ) : (
            action as React.ReactNode
          )}
        </Box>
      )}
    </Box>
  )
}
