'use client'

import { useState } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../base'

export interface TraderStatItemProps {
  label: string
  value: number
  onClick?: () => void
  clickable?: boolean
}

/**
 * A single stat display (e.g. "Followers: 1,234") with hover feedback.
 */
export function TraderStatItem({ label, value, onClick, clickable }: TraderStatItemProps) {
  const [isHovered, setIsHovered] = useState(false)

  return (
    <Box
      style={{
        flex: 1,
        cursor: clickable ? 'pointer' : 'default',
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        background:
          isHovered && clickable ? `${alpha(tokens.colors.accent.primary, 6)}` : 'transparent',
        transition: `all ${tokens.transition.slow}`,
        transform: isHovered && clickable ? 'scale(1.02)' : 'scale(1)',
        textAlign: 'center',
      }}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Text
        size="xs"
        color="tertiary"
        style={{
          fontWeight: tokens.typography.fontWeight.medium,
          marginBottom: tokens.spacing[1],
          display: 'block',
        }}
      >
        {label}
      </Text>
      <Text
        size="lg"
        weight="black"
        style={{
          color: tokens.colors.text.primary,
          display: 'block',
        }}
      >
        {value.toLocaleString('en-US')}
      </Text>
    </Box>
  )
}
