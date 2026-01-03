'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'

type EmptyStateProps = {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}

export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <Box
      style={{
        padding: `${tokens.spacing[16]} ${tokens.spacing[5]}`,
        textAlign: 'center',
      }}
    >
      {icon && (
        <Box style={{ marginBottom: tokens.spacing[4], fontSize: tokens.typography.fontSize['3xl'] }}>
          {icon}
        </Box>
      )}
      <Text size="md" weight="black" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
        {title}
      </Text>
      {description && (
        <Text
          size="sm"
          color="tertiary"
          style={{
            marginBottom: action ? tokens.spacing[5] : 0,
            maxWidth: 400,
            marginLeft: 'auto',
            marginRight: 'auto',
          }}
        >
          {description}
        </Text>
      )}
      {action && <Box>{action}</Box>}
    </Box>
  )
}
