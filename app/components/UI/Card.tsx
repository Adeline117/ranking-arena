'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'

export interface CardProps {
  title?: string
  children: React.ReactNode
  style?: React.CSSProperties
}

export default function Card({ title, children, style }: CardProps) {
  return (
    <Box
      bg="secondary"
      p={4}
      radius="xl"
      border="primary"
      style={{
        boxShadow: tokens.shadow.sm,
        transition: `box-shadow ${tokens.transition.base}`,
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = tokens.shadow.md
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = tokens.shadow.sm
      }}
    >
      {title && (
        <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
          {title}
        </Text>
      )}
      {children}
    </Box>
  )
}
