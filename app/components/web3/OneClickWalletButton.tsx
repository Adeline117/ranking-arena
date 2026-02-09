'use client'

/**
 * One-Click Wallet Sign-In Button
 *
 * A single button that handles the entire SIWE flow:
 * - If not connected: opens wallet modal
 * - Once connected: automatically prompts for signature
 * - Shows clear status feedback at each step
 */

import { useOneClickSiwe, type OneClickStatus } from '@/lib/web3/useOneClickSiwe'
import { useAccountModal } from '@rainbow-me/rainbowkit'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

// ============================================
// Types
// ============================================

interface OneClickWalletButtonProps {
  /** Callback on successful sign-in */
  onSuccess?: (result: { userId: string; handle?: string; walletAddress: string }) => void
  /** Callback on error */
  onError?: (error: string) => void
  /** Custom className for styling */
  className?: string
  /** Custom inline styles */
  style?: React.CSSProperties
  /** Button size variant */
  size?: 'sm' | 'md' | 'lg'
  /** Full width button */
  fullWidth?: boolean
  /** Disabled state */
  disabled?: boolean
}

// ============================================
// Status Icons
// ============================================

function WalletIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M22 10H18a2 2 0 0 0-2 2 2 2 0 0 0 2 2h4" />
    </svg>
  )
}

function SpinnerIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  )
}

function CheckIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function SwitchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 3l4 4-4 4" />
      <path d="M20 7H4" />
      <path d="M8 21l-4-4 4-4" />
      <path d="M4 17h16" />
    </svg>
  )
}

// ============================================
// Helper Functions
// ============================================

function getStatusText(status: OneClickStatus, address: string | undefined, t: (key: string) => string): string {
  switch (status) {
    case 'connecting':
      return t('siweOneClickConnecting')
    case 'signing':
      return t('siweOneClickSigning')
    case 'verifying':
      return t('siweOneClickVerifying')
    case 'success':
      return t('siweOneClickSuccess')
    case 'error':
    case 'idle':
    default:
      if (address) {
        const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`
        return `${t('siweOneClickSignIn')} (${shortAddr})`
      }
      return t('siweOneClickButton')
  }
}

function getStatusIcon(status: OneClickStatus, address: string | undefined, size: number) {
  switch (status) {
    case 'connecting':
    case 'signing':
    case 'verifying':
      return <SpinnerIcon size={size} />
    case 'success':
      return <CheckIcon size={size} />
    case 'error':
    case 'idle':
    default:
      return <WalletIcon size={size} />
  }
}

// ============================================
// Size Variants
// ============================================

const sizeStyles = {
  sm: {
    padding: '10px 16px',
    fontSize: 13,
    iconSize: 16,
    gap: 8,
    borderRadius: tokens.radius.md,
  },
  md: {
    padding: '14px 20px',
    fontSize: 16,
    iconSize: 18,
    gap: 10,
    borderRadius: tokens.radius.lg,
  },
  lg: {
    padding: '16px 24px',
    fontSize: 16,
    iconSize: 20,
    gap: 12,
    borderRadius: 14,
  },
}

// ============================================
// Component
// ============================================

export function OneClickWalletButton({
  onSuccess,
  onError,
  className = '',
  style = {},
  size = 'md',
  fullWidth = false,
  disabled = false,
}: OneClickWalletButtonProps) {
  const { t } = useLanguage()
  const { openAccountModal } = useAccountModal()
  const { signIn, status, isLoading, error, reset, address, isConnected } = useOneClickSiwe({
    autoSign: true,
    onSuccess,
    onError,
  })

  const sizeConfig = sizeStyles[size]
  const isDisabled = disabled || isLoading

  const handleClick = async () => {
    if (isDisabled) return

    // If there was an error, reset first
    if (status === 'error') {
      reset()
    }

    await signIn()
  }

  const handleSwitchAccount = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (openAccountModal) {
      openAccountModal()
    }
  }

  // Determine button appearance based on status
  const getButtonStyles = (): React.CSSProperties => {
    const baseStyles: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: sizeConfig.gap,
      padding: sizeConfig.padding,
      fontSize: sizeConfig.fontSize,
      fontWeight: 700,
      borderRadius: sizeConfig.borderRadius,
      cursor: isDisabled ? 'not-allowed' : 'pointer',
      transition: 'all 0.2s ease',
      border: 'none',
      ...style,
    }

    switch (status) {
      case 'success':
        return {
          ...baseStyles,
          background: 'linear-gradient(135deg, ${tokens.colors.accent.success} 0%, ${tokens.colors.accent.success} 100%)',
          color: tokens.colors.white,
        }
      case 'error':
        return {
          ...baseStyles,
          background: 'var(--color-red-bg-light)',
          border: '1px solid var(--color-red-border)',
          color: tokens.colors.accent.error,
        }
      case 'connecting':
      case 'signing':
      case 'verifying':
        return {
          ...baseStyles,
          background: 'rgba(99, 102, 241, 0.2)',
          color: tokens.colors.accent.brandLight,
          opacity: 0.9,
        }
      default:
        if (address) {
          // Connected but idle - show gradient
          return {
            ...baseStyles,
            background: 'linear-gradient(135deg, ${tokens.colors.accent.brand} 0%, ${tokens.colors.accent.brandHover} 100%)',
            color: tokens.colors.white,
          }
        }
        // Not connected
        return {
          ...baseStyles,
          background: 'var(--color-accent-primary-08)',
          border: '1px solid var(--color-accent-primary-30)',
          color: tokens.colors.accent.brandLight,
        }
    }
  }

  return (
    <div style={{ width: fullWidth ? '100%' : 'auto' }}>
      <style>
        {`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          .one-click-wallet-btn:not(:disabled):hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
          }
          .one-click-wallet-btn:not(:disabled):active {
            transform: translateY(0) scale(0.98);
          }
        `}
      </style>

      <div style={{ display: 'flex', gap: 8, width: fullWidth ? '100%' : 'auto' }}>
        <button
          onClick={handleClick}
          disabled={isDisabled}
          className={`one-click-wallet-btn ${className}`}
          style={{ ...getButtonStyles(), flex: 1 }}
        >
          {getStatusIcon(status, address, sizeConfig.iconSize)}
          <span>{getStatusText(status, address, t)}</span>
        </button>

        {/* Switch account button - only show when connected and idle */}
        {isConnected && address && status === 'idle' && openAccountModal && (
          <button
            onClick={handleSwitchAccount}
            className="one-click-wallet-btn"
            title={t('siweOneClickSwitch')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: sizeConfig.padding.split(' ')[0],
              borderRadius: sizeConfig.borderRadius,
              background: 'var(--color-accent-primary-08)',
              border: '1px solid var(--color-accent-primary-30)',
              color: tokens.colors.accent.brandLight,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            <SwitchIcon size={sizeConfig.iconSize} />
          </button>
        )}
      </div>

      {/* Error message */}
      {error && status === 'error' && (
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            borderRadius: tokens.radius.md,
            background: 'var(--color-red-bg-light)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            fontSize: 12,
            color: tokens.colors.accent.error,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              reset()
            }}
            style={{
              marginLeft: 'auto',
              padding: '2px 8px',
              borderRadius: tokens.radius.sm,
              border: 'none',
              background: 'rgba(239, 68, 68, 0.2)',
              color: tokens.colors.accent.error,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('siweRetry')}
          </button>
        </div>
      )}
    </div>
  )
}

export default OneClickWalletButton
