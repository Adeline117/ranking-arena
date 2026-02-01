'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type ErrorMessageProps = {
  title?: string
  message: string
  onRetry?: () => void
}

export default function ErrorMessage({ title, message, onRetry }: ErrorMessageProps) {
  const { t } = useLanguage()
  const displayTitle = title || t('somethingWentWrong')

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
        {displayTitle}
      </Text>
      <Text size="sm" style={{ color: tokens.colors.accent.error, marginBottom: onRetry ? tokens.spacing[3] : 0 }}>
        {message}
      </Text>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} style={{ marginTop: tokens.spacing[3] }}>
          {t('retry')}
        </Button>
      )}
    </Box>
  )
}
