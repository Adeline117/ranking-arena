'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type ErrorStateProps = {
  title?: string
  description?: string
  retry?: () => void
  variant?: 'default' | 'compact'
}

export default function ErrorState({ title, description, retry, variant = 'default' }: ErrorStateProps) {
  const { t } = useLanguage()
  const isCompact = variant === 'compact'
  const displayTitle = title || t('somethingWentWrong')

  return (
    <Box
      role="alert"
      className="card-enter"
      style={{
        padding: isCompact
          ? `${tokens.spacing[8]} ${tokens.spacing[4]}`
          : `${tokens.spacing[16]} ${tokens.spacing[6]}`,
        textAlign: 'center',
      }}
    >
      {/* Error icon */}
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
            background: tokens.gradient.errorSubtle,
            border: `1px solid ${tokens.colors.accent.error}20`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            width={isCompact ? 24 : 32}
            height={isCompact ? 24 : 32}
            viewBox="0 0 24 24"
            fill="none"
            stroke={tokens.colors.accent.error}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </Box>
      </Box>

      {/* Title */}
      <Text
        size={isCompact ? 'sm' : 'md'}
        weight="black"
        color="primary"
        style={{ marginBottom: tokens.spacing[2] }}
      >
        {displayTitle}
      </Text>

      {/* Description */}
      {description && (
        <Text
          size={isCompact ? 'xs' : 'sm'}
          color="tertiary"
          style={{
            marginBottom: retry ? tokens.spacing[5] : 0,
            maxWidth: 360,
            marginLeft: 'auto',
            marginRight: 'auto',
            lineHeight: 1.6,
          }}
        >
          {description}
        </Text>
      )}

      {/* Retry button */}
      {retry && (
        <Box style={{ marginTop: tokens.spacing[4] }}>
          <Button variant="secondary" size="sm" onClick={retry}>
            {t('retry')}
          </Button>
        </Box>
      )}
    </Box>
  )
}
