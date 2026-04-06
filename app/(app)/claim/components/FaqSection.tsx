'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'

function useFaqItems() {
  const { t } = useLanguage()
  return [
    { q: t('claimPageFaqWhat'), a: t('claimPageFaqWhatAnswer') },
    { q: t('claimPageFaqHow'), a: t('claimPageFaqHowAnswer') },
    { q: t('claimPageFaqExchanges'), a: t('claimPageFaqExchangesAnswer') },
    { q: t('claimPageFaqSafe'), a: t('claimPageFaqSafeAnswer') },
  ]
}

export function FaqSection() {
  const { t } = useLanguage()
  const faqItems = useFaqItems()
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <Box style={{
      maxWidth: '700px',
      margin: `0 auto ${tokens.spacing[8]}`,
    }}>
      <h2 style={{
        fontSize: tokens.typography.fontSize['2xl'],
        fontWeight: 700,
        textAlign: 'center',
        marginBottom: tokens.spacing[5],
        color: tokens.colors.text.primary,
      }}>
        {t('claimPageFaqTitle')}
      </h2>

      {faqItems.map((item, i) => (
        <Box key={i} style={{
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          padding: `${tokens.spacing[4]} 0`,
        }}>
          <button
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'none',
              border: 'none',
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.md,
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
              textAlign: 'left',
            }}
          >
            {item.q}
            <span style={{
              transform: openIndex === i ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.2s',
              flexShrink: 0,
              marginLeft: tokens.spacing[2],
            }}>
              &#9660;
            </span>
          </button>
          {openIndex === i && (
            <Text style={{
              marginTop: tokens.spacing[2],
              color: tokens.colors.text.secondary,
              lineHeight: 1.7,
              fontSize: tokens.typography.fontSize.sm,
            }}>
              {item.a}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}
