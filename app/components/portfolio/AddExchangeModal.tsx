'use client'

import React, { useState } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

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
      setError(t('apiKeySecretRequired'))
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
      setError(err instanceof Error ? err.message : t('failedToAddExchange'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={styles.overlay} onClick={onClose} role="presentation">
      <div style={styles.modal} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('connectExchange')}>
        <div style={styles.header}>
          <h3 style={styles.title}>{t('connectExchange')}</h3>
          <button style={styles.closeBtn} onClick={onClose} aria-label={t('close')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>{t('exchange')}</label>
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
            <label style={styles.label}>{t('labelOptional')}</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Main Account"
              style={styles.input}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>{t('apiKey')} <span style={{ color: 'var(--color-accent-error)' }}>*</span></label>
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
            <label style={styles.label}>{t('apiSecret')} <span style={{ color: 'var(--color-accent-error)' }}>*</span></label>
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
            {t('apiKeyReadOnlyHint')}
          </div>

          <button type="submit" disabled={submitting} style={{
            ...styles.submitBtn,
            opacity: submitting ? 0.6 : 1,
            cursor: submitting ? 'not-allowed' : 'pointer',
          }}>
            {submitting ? `⏳ ${t('connecting')}` : t('connect')}
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
    backgroundColor: 'var(--color-backdrop-heavy, rgba(0, 0, 0, 0.6))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: tokens.zIndex.modal,
    padding: '16px',
  },
  modal: {
    width: '100%',
    maxWidth: '440px',
    backgroundColor: 'var(--color-bg-secondary)',
    borderRadius: tokens.radius.xl,
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
    padding: '8px 12px',
    minWidth: 44,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
    borderRadius: tokens.radius.md,
    border: '1px solid var(--color-border-primary)',
    backgroundColor: 'var(--color-bg-tertiary)',
    color: 'var(--color-text-primary)',
    fontSize: tokens.typography.fontSize.base,
    outline: 'none',
  },
  select: {
    padding: '10px 12px',
    borderRadius: tokens.radius.md,
    border: '1px solid var(--color-border-primary)',
    backgroundColor: 'var(--color-bg-tertiary)',
    color: 'var(--color-text-primary)',
    fontSize: tokens.typography.fontSize.base,
    outline: 'none',
  },
  error: {
    margin: 0,
    fontSize: tokens.typography.fontSize.sm,
    color: 'var(--color-error)',
  },
  hint: {
    fontSize: tokens.typography.fontSize.xs,
    color: 'var(--color-text-tertiary)',
    lineHeight: 1.5,
  },
  submitBtn: {
    padding: tokens.spacing[3],
    borderRadius: tokens.radius.lg,
    border: 'none',
    backgroundColor: 'var(--color-brand)',
    color: 'var(--color-on-accent, #fff)',
    fontSize: tokens.typography.fontSize.base,
    fontWeight: tokens.typography.fontWeight.semibold,
    cursor: 'pointer',
  },
}
