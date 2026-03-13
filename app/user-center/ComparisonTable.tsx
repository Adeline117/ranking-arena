'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { CheckIcon, CloseIcon } from './MembershipIcons'
import { getComparisonData } from './membership-config'

interface ComparisonTableProps {
  cardStyle: React.CSSProperties
  t: (key: string) => string
}

export default function ComparisonTable({ cardStyle, t }: ComparisonTableProps) {
  return (
    <div style={cardStyle}>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
        {t('freeVsProComparison')}
      </h3>

      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 14,
          minWidth: 360,
        }}>
          <thead>
            <tr>
              <th style={{
                textAlign: 'left',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderBottom: `2px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 600,
              }}>
                {t('feature')}
              </th>
              <th style={{
                textAlign: 'center',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderBottom: `2px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 600,
                width: 100,
              }}>
                {t('free')}
              </th>
              <th style={{
                textAlign: 'center',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderBottom: `2px solid ${tokens.colors.border.primary}`,
                color: 'var(--color-pro-gradient-start)',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 700,
                width: 100,
              }}>
                {t('pro')}
              </th>
            </tr>
          </thead>
          <tbody>
            {getComparisonData(t).map((row, index) => (
              <tr key={index}>
                <td style={{
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                  fontSize: tokens.typography.fontSize.sm,
                  color: tokens.colors.text.secondary,
                }}>
                  {row.feature}
                </td>
                <td style={{
                  textAlign: 'center',
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                }}>
                  {row.free === true ? (
                    <Box style={{ color: 'var(--color-accent-success)', display: 'inline-flex' }}>
                      <CheckIcon size={18} />
                    </Box>
                  ) : row.free === false ? (
                    <Box style={{ color: 'var(--color-text-tertiary)', display: 'inline-flex' }}>
                      <CloseIcon size={18} />
                    </Box>
                  ) : (
                    <Text size="sm" color="secondary">{row.free}</Text>
                  )}
                </td>
                <td style={{
                  textAlign: 'center',
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                  background: 'var(--color-pro-glow)',
                }}>
                  {row.pro === true ? (
                    <Box style={{ color: 'var(--color-pro-gradient-start)', display: 'inline-flex' }}>
                      <CheckIcon size={18} />
                    </Box>
                  ) : (
                    <Text size="sm" weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
                      {row.pro}
                    </Text>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
