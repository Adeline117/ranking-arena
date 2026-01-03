'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'

type ErrorMessageProps = {
  title?: string
  message: string
  onRetry?: () => void
}

export default function ErrorMessage({ title = '出错了', message, onRetry }: ErrorMessageProps) {
  return (
    <Box
      bg="secondary"
      p={6}
      radius="lg"
      border="primary"
      style={{
        background: `rgba(255, 68, 68, 0.1)`,
        borderColor: `rgba(255, 68, 68, 0.3)`,
      }}
    >
      <Text size="md" weight="black" style={{ color: tokens.colors.accent.error, marginBottom: tokens.spacing[2] }}>
        {title}
      </Text>
      <Text size="sm" style={{ color: tokens.colors.accent.error, marginBottom: onRetry ? tokens.spacing[3] : 0 }}>
        {message}
      </Text>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} style={{ marginTop: tokens.spacing[3] }}>
          重试
        </Button>
      )}
    </Box>
  )
}
