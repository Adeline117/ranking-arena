'use client'

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useMultiAccount } from '@/lib/hooks/useMultiAccount'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface AccountSwitcherProps {
  onClose?: () => void
}

const truncateStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

interface AccountRowProps {
  userId: string
  avatarUrl?: string | null
  handle?: string | null
  email: string
  isActive?: boolean
  isSwitching?: boolean
  disabled?: boolean
  switchingLabel?: string
  onClick?: () => void
}

function AccountRow({
  userId,
  avatarUrl,
  handle,
  email,
  isActive,
  isSwitching,
  disabled,
  switchingLabel,
  onClick,
}: AccountRowProps): React.ReactElement {
  const displayName = handle || email

  return (
    <Box
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        background: isActive ? `${tokens.colors.accent.primary}10` : 'transparent',
        cursor: onClick ? (disabled ? 'wait' : 'pointer') : undefined,
        opacity: disabled && !isSwitching ? 0.5 : 1,
        transition: `all ${tokens.transition.base}`,
      }}
      onMouseEnter={(e) => {
        if (onClick && !disabled && !isActive) {
          e.currentTarget.style.background = tokens.colors.bg.secondary
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'transparent'
        }
      }}
    >
      <Avatar userId={userId} avatarUrl={avatarUrl} name={displayName} size={28} />
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" weight={isActive ? 'bold' : undefined} style={truncateStyle}>
          {displayName}
        </Text>
        {isActive && handle && (
          <Text size="xs" color="tertiary" style={truncateStyle}>
            {email}
          </Text>
        )}
      </Box>
      {isActive && (
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ color: tokens.colors.accent.success }}>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )}
      {isSwitching && <Text size="xs" color="tertiary">{switchingLabel}</Text>}
    </Box>
  )
}

export default function AccountSwitcher({ onClose }: AccountSwitcherProps): React.ReactElement {
  const router = useRouter()
  const { t } = useLanguage()
  const { accounts, activeAccount, inactiveAccounts, isPro, switchAccount, removeAccount, signOutAll } = useMultiAccount()
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSwitch = useCallback(async (userId: string) => {
    setSwitchingId(userId)
    setError(null)
    const result = await switchAccount(userId)
    setSwitchingId(null)

    if (!result.success) {
      const errorMessage = result.error === 'session_expired' ? t('sessionExpired') : t('switchFailed')
      setError(errorMessage)
      if (result.error === 'session_expired') {
        removeAccount(userId)
      }
      return
    }

    onClose?.()
    // 完整刷新页面以确保session正确切换
    window.location.reload()
  }, [switchAccount, removeAccount, onClose, t])

  const handleAddAccount = useCallback(() => {
    onClose?.()
    if (!isPro) {
      router.push('/settings?section=subscription')
      return
    }
    router.push('/login?addAccount=true')
  }, [isPro, onClose, router])

  const handleSignOutAll = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (signingOut) return
    setSigningOut(true)
    try {
      await signOutAll()
      onClose?.()
      router.push('/')
    } catch (err) {
      console.error('Sign out failed:', err)
    } finally {
      setSigningOut(false)
    }
  }, [signingOut, signOutAll, onClose, router])

  return (
    <Box style={{ padding: `${tokens.spacing[1]} 0` }}>
      {activeAccount && (
        <AccountRow
          userId={activeAccount.userId}
          avatarUrl={activeAccount.avatarUrl}
          handle={activeAccount.handle}
          email={activeAccount.email}
          isActive
        />
      )}

      {inactiveAccounts.map((account) => (
        <AccountRow
          key={account.userId}
          userId={account.userId}
          avatarUrl={account.avatarUrl}
          handle={account.handle}
          email={account.email}
          isSwitching={switchingId === account.userId}
          disabled={Boolean(switchingId)}
          switchingLabel={t('switchingAccount')}
          onClick={() => handleSwitch(account.userId)}
        />
      ))}

      {error && (
        <Text size="xs" style={{ color: tokens.colors.accent.error, padding: `${tokens.spacing[1]} ${tokens.spacing[3]}` }}>
          {error}
        </Text>
      )}

      <Box style={{ height: 1, background: tokens.colors.border.primary, margin: `${tokens.spacing[2]} 0` }} />

      <MenuRow onClick={handleAddAccount}>
        <Box
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: `1px dashed ${tokens.colors.border.secondary}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            color: tokens.colors.text.tertiary,
          }}
        >
          +
        </Box>
        <Text size="sm" color="secondary">{t('addAccount')}</Text>
        {!isPro && <ProBadge />}
      </MenuRow>

      {accounts.length > 1 && (
        <MenuRow onClick={handleSignOutAll} disabled={signingOut}>
          <Text size="xs" style={{ color: tokens.colors.accent.error }}>
            {signingOut ? t('signingOut') : t('signOutAll')}
          </Text>
        </MenuRow>
      )}
    </Box>
  )
}

interface MenuRowProps {
  onClick: (e: React.MouseEvent) => void
  disabled?: boolean
  children: React.ReactNode
}

function MenuRow({ onClick, disabled, children }: MenuRowProps): React.ReactElement {
  return (
    <Box
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onClick(e)
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: `all ${tokens.transition.base}`,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = tokens.colors.bg.secondary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </Box>
  )
}

function ProBadge(): React.ReactElement {
  return (
    <Box
      style={{
        marginLeft: 'auto',
        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
        borderRadius: tokens.radius.sm,
        background: `linear-gradient(135deg, ${tokens.colors.accent.brand}, ${tokens.colors.accent.brandHover})`,
        color: tokens.colors.white,
        fontSize: 10,
        fontWeight: 700,
      }}
    >
      Pro
    </Box>
  )
}
