'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useMultiAccount } from '@/lib/hooks/useMultiAccount'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export function MultiAccountSection() {
  const { accounts, isPro, removeAccount, switchAccount } = useMultiAccount()
  const router = useRouter()
  const { t } = useLanguage()
  const [switchingId, setSwitchingId] = useState<string | null>(null)

  const handleSwitch = async (userId: string) => {
    setSwitchingId(userId)
    const result = await switchAccount(userId)
    setSwitchingId(null)
    if (result.success) {
      router.refresh()
    }
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {accounts.map((account) => (
        <Box
          key={account.userId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            background: account.isActive ? `${tokens.colors.accent.primary}10` : 'transparent',
            border: `1px solid ${account.isActive ? tokens.colors.accent.primary + '30' : tokens.colors.border.primary}`,
          }}
        >
          <Box style={{
            width: 24, height: 24, borderRadius: '50%',
            background: tokens.colors.accent.primary + '20',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: tokens.colors.accent.primary,
          }}>
            {(account.handle?.[0] || account.email[0] || 'U').toUpperCase()}
          </Box>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="xs" weight={account.isActive ? 'bold' : 'normal'} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {account.handle || account.email}
            </Text>
          </Box>
          {account.isActive ? (
            <Text size="xs" style={{ color: tokens.colors.accent.success }}>{t('current')}</Text>
          ) : (
            <Box style={{ display: 'flex', gap: tokens.spacing[1] }}>
              <button
                onClick={() => handleSwitch(account.userId)}
                disabled={!!switchingId}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  fontSize: 11, color: tokens.colors.accent.primary,
                  opacity: switchingId ? 0.5 : 1,
                }}
              >
                {switchingId === account.userId ? (t('switching') || 'Switching...') : t('switchAccount')}
              </button>
              <button
                onClick={() => removeAccount(account.userId)}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  fontSize: 11, color: tokens.colors.text.tertiary,
                }}
              >
                {t('removeAccount')}
              </button>
            </Box>
          )}
        </Box>
      ))}
      <Box
        onClick={() => {
          if (!isPro && accounts.length >= 1) {
            router.push('/settings?section=subscription')
          } else {
            router.push('/login?addAccount=true')
          }
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: tokens.spacing[2],
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          border: `1px dashed ${tokens.colors.border.secondary}`,
          cursor: 'pointer',
          transition: `all ${tokens.transition.base}`,
        }}
      >
        <Text size="xs" color="tertiary">+ {t('addAccount')}</Text>
        {!isPro && (
          <Box style={{
            marginLeft: 'auto',
            padding: `1px ${tokens.spacing[1]}`,
            borderRadius: tokens.radius.sm,
            background: `linear-gradient(135deg, ${tokens.colors.accent.brand}, var(--color-brand-accent))`,
            color: tokens.colors.white, fontSize: 10, fontWeight: 700,
          }}>
            Pro
          </Box>
        )}
      </Box>
    </Box>
  )
}
