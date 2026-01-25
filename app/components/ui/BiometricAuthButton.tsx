'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useCapacitorBiometric, useCapacitorHaptics } from '@/lib/hooks/useCapacitor'
import { useLanguage } from '../Providers/LanguageProvider'

interface BiometricAuthButtonProps {
  onSuccess: () => void
  onError?: (error: string) => void
  reason?: string
  className?: string
  style?: React.CSSProperties
}

/**
 * Biometric authentication button for Face ID / Touch ID / Fingerprint
 *
 * Usage:
 *   <BiometricAuthButton
 *     onSuccess={() => console.log('Authenticated!')}
 *     onError={(err) => console.error(err)}
 *     reason="Authenticate to access your wallet"
 *   />
 */
export default function BiometricAuthButton({
  onSuccess,
  onError,
  reason,
  className,
  style,
}: BiometricAuthButtonProps) {
  const { language } = useLanguage()
  const { isAvailable, biometryType, authenticate } = useCapacitorBiometric()
  const { notification } = useCapacitorHaptics()
  const [isAuthenticating, setIsAuthenticating] = useState(false)

  if (!isAvailable) return null

  const handleAuth = async () => {
    if (isAuthenticating) return

    setIsAuthenticating(true)
    try {
      const result = await authenticate(reason)

      if (result.success) {
        await notification('success')
        onSuccess()
      } else {
        await notification('error')
        onError?.(result.error || 'Authentication failed')
      }
    } finally {
      setIsAuthenticating(false)
    }
  }

  const getIcon = () => {
    switch (biometryType) {
      case 'face':
        return (
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="9" cy="10" r="1" />
            <circle cx="15" cy="10" r="1" />
            <path d="M9.5 15a3.5 3.5 0 0 0 5 0" />
            <rect x="3" y="3" width="18" height="18" rx="2" />
          </svg>
        )
      case 'fingerprint':
        return (
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
            <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
            <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
            <path d="M2 12a10 10 0 0 1 18-6" />
            <path d="M2 16h.01" />
            <path d="M21.8 16c.2-2 .131-5.354 0-6" />
            <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
            <path d="M8.65 22c.21-.66.45-1.32.57-2" />
            <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
          </svg>
        )
      default:
        return (
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        )
    }
  }

  const getLabel = () => {
    const labels = {
      face: language === 'zh' ? '使用面容 ID' : 'Use Face ID',
      fingerprint: language === 'zh' ? '使用指纹' : 'Use Fingerprint',
      iris: language === 'zh' ? '使用虹膜' : 'Use Iris',
      none: language === 'zh' ? '生物识别' : 'Biometric',
    }
    return labels[biometryType]
  }

  return (
    <button
      onClick={handleAuth}
      disabled={isAuthenticating}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[2],
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        borderRadius: tokens.radius.lg,
        background: tokens.glass.bg.light,
        border: `1px solid ${tokens.colors.border.primary}`,
        color: tokens.colors.text.primary,
        fontSize: tokens.typography.fontSize.sm,
        fontWeight: tokens.typography.fontWeight.medium,
        cursor: isAuthenticating ? 'wait' : 'pointer',
        opacity: isAuthenticating ? 0.7 : 1,
        transition: `all ${tokens.transition.fast}`,
        width: '100%',
        ...style,
      }}
    >
      {isAuthenticating ? (
        <span
          style={{
            width: 24,
            height: 24,
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
      ) : (
        getIcon()
      )}
      {getLabel()}
    </button>
  )
}
