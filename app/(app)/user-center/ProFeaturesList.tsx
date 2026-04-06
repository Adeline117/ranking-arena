'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { CheckIcon } from './MembershipIcons'
import { getProFeatures } from './membership-config'

interface ProFeaturesListProps {
  cardStyle: React.CSSProperties
  t: (key: string) => string
}

export default function ProFeaturesList({ cardStyle, t }: ProFeaturesListProps) {
  return (
    <div style={cardStyle}>
      <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[4], color: tokens.colors.text.primary }}>
        {t('proExclusiveFeatures')}
      </Text>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {getProFeatures(t).map((feature, index) => (
          <Box
            key={index}
            style={{
              display: 'flex',
              gap: tokens.spacing[3],
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.secondary}`,
            }}
          >
            <Box
              style={{
                width: 28,
                height: 28,
                borderRadius: tokens.radius.md,
                background: 'var(--color-pro-glow)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-pro-gradient-start)',
                flexShrink: 0,
              }}
            >
              <CheckIcon size={14} />
            </Box>
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: 2 }}>
                {feature.title}
              </Text>
              <Text size="xs" color="tertiary">
                {feature.desc}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    </div>
  )
}
