'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export function ExchangeBindingBanner({ userId }: { userId: string | null }) {
  const { t } = useLanguage()
  const [show, setShow] = useState<boolean | null>(null)

  useEffect(() => {
    if (!userId) return
    Promise.resolve(
      supabase
        .from('user_exchange_connections')
        .select('id')
        .eq('user_id', userId)
        .limit(1)
    ).then(({ data }) => {
      setShow(!data || data.length === 0)
    }).catch(() => { /* Exchange connection check non-critical */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [userId])

  if (!show) return null

  return (
    <Box
      style={{
        marginBottom: tokens.spacing[6],
        padding: tokens.spacing[5],
        borderRadius: tokens.radius['2xl'],
        background: `linear-gradient(135deg, ${tokens.colors.accent.primary}12, ${tokens.colors.accent.brand}08)`,
        border: `1px solid ${tokens.colors.accent.primary}30`,
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[4],
      }}
    >
      <Box style={{
        width: 48, height: 48, borderRadius: tokens.radius.lg,
        background: `${tokens.colors.accent.primary}20`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </Box>
      <Box style={{ flex: 1 }}>
        <Text size="sm" weight="bold" style={{ marginBottom: 4 }}>
          {t('bindExchangeBannerTitle')}
        </Text>
        <Text size="xs" color="tertiary">
          {t('bindExchangeBannerDesc')}
        </Text>
      </Box>
      <Link href="/exchange/auth" style={{ textDecoration: 'none', flexShrink: 0 }}>
        <Button variant="primary" size="sm">
          {t('goToBind')}
        </Button>
      </Link>
    </Box>
  )
}
