'use client'

import React, { useState } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const SUPPORTED_EXCHANGES = [
  'binance',
  'bybit',
  'okx',
  'bitget',
  'mexc',
  'kucoin',
  'gateio',
  'htx',
  'phemex',
  'dydx',
  'hyperliquid',
  'blofin',
  'coinex',
  'bitmart',
]

interface AddExchangeModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (data: { exchange: string; api_key: string; api_secret: string; label: string }) => Promise<void>
}

export default function AddExchangeModal({ open, onClose, onSubmit }: AddExchangeModalProps) {
  const { t } = useLanguage()
  const [exchange, setExchange] = useState(SUPPORTED_EXCHANGES[0])
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [label, setLabel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiKey.trim() || !apiSecret.trim()) {
      setError('API Key and Secret are required')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      await onSubmit({
        exchange,
        api_key: apiKey.trim(),
        api_secret: apiSecret.trim(),
        label: label.trim() || exchange,
      })
      setApiKey('')
      setApiSecret('')
      setLabel('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add exchange')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={styles.title}>Connect Exchange</h3>
          <button style={styles.closeBtn} onClick={onClose} aria-label="Close">
            x
          </button>
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>Exchange</label>
            <select
              value={exchange}
              onChange={e => setExchange(e.target.value)}
              style={styles.select}
            >
              {SUPPORTED_EXCHANGES.map(ex => (
                <option key={ex} value={ex}>
                  {ex.charAt(0).toUpperCase() + ex.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Label (optional)</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Main Account"
              style={styles.input}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={t('enterApiKeyPlaceholder')}
              style={styles.input}
              autoComplete="off"
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>API Secret</label>
            <input
              type="password"
              value={apiSecret}
              onChange={e => setApiSecret(e.target.value)}
              placeholder={t('enterApiSecretPlaceholder')}
              style={styles.input}
              autoComplete="off"
            />
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <div style={styles.hint}>
            Use read-only API keys. Do not enable trading or withdrawal permissions.
          </div>

          <button type="submit" disabled={submitting} style={{
            ...styles.submitBtn,
            opacity: submitting ? 0.6 : 1,
          }}>
            {submitting ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '16px',
  },
  modal: {
    width: '100%',
    maxWidth: '440px',
    backgroundColor: 'var(--color-bg-secondary)',
    borderRadius: '16px',
    border: '1px solid var(--color-border-primary)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid var(--color-border-primary)',
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-text-secondary)',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '4px 8px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    padding: '20px',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--color-text-secondary)',
  },
  input: {
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid var(--color-border-primary)',
    backgroundColor: 'var(--color-bg-tertiary)',
    color: 'var(--color-text-primary)',
    fontSize: '14px',
    outline: 'none',
  },
  select: {
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid var(--color-border-primary)',
    backgroundColor: 'var(--color-bg-tertiary)',
    color: 'var(--color-text-primary)',
    fontSize: '14px',
    outline: 'none',
  },
  error: {
    margin: 0,
    fontSize: '13px',
    color: 'var(--color-error)',
  },
  hint: {
    fontSize: '12px',
    color: 'var(--color-text-tertiary)',
    lineHeight: 1.5,
  },
  submitBtn: {
    padding: '12px',
    borderRadius: '10px',
    border: 'none',
    backgroundColor: 'var(--color-brand)',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
  },
}
