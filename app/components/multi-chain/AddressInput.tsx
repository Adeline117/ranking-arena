'use client'

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface AddressInputProps {
  onSubmit: (address: string) => void
  isLoading?: boolean
}

export default function AddressInput({ onSubmit, isLoading }: AddressInputProps) {
  const { t } = useLanguage()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('Please enter a wallet address')
      return
    }

    // Basic validation: EVM or Solana
    const isEvm = /^0x[a-fA-F0-9]{40}$/.test(trimmed)
    const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)

    if (!isEvm && !isSolana) {
      setError('Invalid address. Enter an EVM (0x...) or Solana address.')
      return
    }

    setError(null)
    onSubmit(trimmed)
  }, [value, onSubmit])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      <div style={{ display: 'flex', gap: tokens.spacing[2] }}>
        <input
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
          placeholder={t('enterEvmOrSolanaAddress')}
          aria-label={t('enterEvmOrSolanaAddress')}
          disabled={isLoading}
          style={{
            flex: 1,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${error ? 'var(--color-accent-error)' : tokens.colors.border.primary}`,
            borderRadius: tokens.radius.lg,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            fontFamily: 'monospace',
            outline: 'none',
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={isLoading || !value.trim()}
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
            background: 'var(--color-accent-primary)',
            border: 'none',
            borderRadius: tokens.radius.lg,
            color: '#fff',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: 600,
            cursor: isLoading ? 'wait' : 'pointer',
            opacity: isLoading || !value.trim() ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {isLoading ? 'Analyzing...' : 'Analyze'}
        </button>
      </div>
      {error && (
        <span style={{ color: 'var(--color-accent-error)', fontSize: tokens.typography.fontSize.xs }}>
          {error}
        </span>
      )}
    </div>
  )
}
