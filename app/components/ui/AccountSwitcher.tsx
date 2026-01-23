'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useMultiAccount } from '@/lib/hooks/useMultiAccount'
import { useRouter } from 'next/navigation'

interface AccountSwitcherProps {
  onClose?: () => void
}

export default function AccountSwitcher({ onClose }: AccountSwitcherProps) {
  const router = useRouter()
  const {
    accounts,
    activeAccount,
    inactiveAccounts,
    canAddAccount,
    isPro,
    switchAccount,
    removeAccount,
    signOutAll,
  } = useMultiAccount()
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSwitch = async (userId: string) => {
    setSwitchingId(userId)
    setError(null)
    const result = await switchAccount(userId)
    setSwitchingId(null)

    if (!result.success) {
      if (result.error === 'session_expired') {
        setError('会话已过期，请重新登录此账号')
        removeAccount(userId)
      } else {
        setError('切换失败，请重试')
      }
      return
    }

    onClose?.()
    router.refresh()
  }

  const handleAddAccount = () => {
    if (!isPro) {
      router.push('/settings?section=subscription')
      onClose?.()
      return
    }
    // Sign out current and redirect to login to add another
    onClose?.()
    router.push('/login?addAccount=true')
  }

  return (
    <Box style={{ padding: `${tokens.spacing[1]} 0` }}>
      {/* Current account */}
      {activeAccount && (
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            background: `${tokens.colors.accent.primary}10`,
          }}
        >
          <Avatar
            userId={activeAccount.userId}
            avatarUrl={activeAccount.avatarUrl}
            name={activeAccount.handle || activeAccount.email}
            size={28}
          />
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" weight="bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeAccount.handle || activeAccount.email}
            </Text>
            {activeAccount.handle && (
              <Text size="xs" color="tertiary" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeAccount.email}
              </Text>
            )}
          </Box>
          <Text size="xs" style={{ color: tokens.colors.accent.success }}>✓</Text>
        </Box>
      )}

      {/* Inactive accounts */}
      {inactiveAccounts.map((account) => (
        <Box
          key={account.userId}
          onClick={() => handleSwitch(account.userId)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            cursor: switchingId ? 'wait' : 'pointer',
            opacity: switchingId && switchingId !== account.userId ? 0.5 : 1,
            transition: `all ${tokens.transition.base}`,
          }}
          onMouseEnter={(e) => {
            if (!switchingId) e.currentTarget.style.background = tokens.colors.bg.secondary
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <Avatar
            userId={account.userId}
            avatarUrl={account.avatarUrl}
            name={account.handle || account.email}
            size={28}
          />
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {account.handle || account.email}
            </Text>
          </Box>
          {switchingId === account.userId && (
            <Text size="xs" color="tertiary">切换中...</Text>
          )}
        </Box>
      ))}

      {error && (
        <Text size="xs" style={{ color: tokens.colors.accent.error, padding: `${tokens.spacing[1]} ${tokens.spacing[3]}` }}>
          {error}
        </Text>
      )}

      {/* Divider */}
      <Box style={{ height: 1, background: tokens.colors.border.primary, margin: `${tokens.spacing[2]} 0` }} />

      {/* Add account */}
      <Box
        onClick={handleAddAccount}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          cursor: 'pointer',
          transition: `all ${tokens.transition.base}`,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
      >
        <Box style={{
          width: 28, height: 28,
          borderRadius: '50%',
          border: `1px dashed ${tokens.colors.border.secondary}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, color: tokens.colors.text.tertiary,
        }}>
          +
        </Box>
        <Text size="sm" color="secondary">添加账号</Text>
        {!isPro && (
          <Box style={{
            marginLeft: 'auto',
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            borderRadius: tokens.radius.sm,
            background: 'linear-gradient(135deg, #8b6fa8, #b794d4)',
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
          }}>
            Pro
          </Box>
        )}
      </Box>

      {/* Sign out all */}
      {accounts.length > 1 && (
        <Box
          onClick={async () => {
            await signOutAll()
            onClose?.()
            router.push('/')
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          <Text size="xs" style={{ color: tokens.colors.accent.error }}>退出所有账号</Text>
        </Box>
      )}
    </Box>
  )
}
