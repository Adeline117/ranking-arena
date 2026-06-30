'use client'

import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Spinner } from './loginHelpers'

interface OTPVerificationProps {
  code: string
  setCode: (code: string) => void
  countdown: number
  loading: boolean
  sendingCode: boolean
  email: string
  onVerify: () => void
  onResend: () => void
  onSwitchToPassword?: () => void
  t: (key: string) => string
}

const OTP_LENGTH = 6

export default function OTPVerification({
  code,
  setCode,
  countdown,
  loading,
  sendingCode: _sendingCode,
  email,
  onVerify,
  onResend,
  onSwitchToPassword,
  t,
}: OTPVerificationProps) {
  const [boxes, setBoxes] = useState<string[]>(() => Array(OTP_LENGTH).fill(''))
  const inputsRef = useRef<(HTMLInputElement | null)[]>([])
  const autoSubmittedRef = useRef(false)

  // Keep local boxes in sync when the parent clears the code (e.g. resend / reset).
  useEffect(() => {
    if (!code) setBoxes(Array(OTP_LENGTH).fill(''))
  }, [code])

  // Auto-submit once all digits are present. Runs off the parent `code` so the
  // verify handler reads the fully-committed value (not a stale closure).
  useEffect(() => {
    if (code.length === OTP_LENGTH && !loading && !autoSubmittedRef.current) {
      autoSubmittedRef.current = true
      onVerify()
    }
    if (code.length < OTP_LENGTH) autoSubmittedRef.current = false
  }, [code, loading, onVerify])

  const focusBox = (i: number) => {
    const el = inputsRef.current[i]
    if (el) el.focus()
  }

  const commit = (next: string[]) => {
    setBoxes(next)
    setCode(next.join(''))
  }

  const distribute = (digits: string, start: number) => {
    const next = [...boxes]
    let cursor = start
    for (const ch of digits) {
      if (cursor >= OTP_LENGTH) break
      next[cursor] = ch
      cursor += 1
    }
    commit(next)
    focusBox(Math.min(cursor, OTP_LENGTH - 1))
  }

  const handleChange = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '')
    if (digits.length > 1) {
      // Paste / autofill landing inside a box — spread across segments.
      distribute(digits, index)
      return
    }
    const next = [...boxes]
    next[index] = digits
    commit(next)
    if (digits) focusBox(index + 1)
  }

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (!loading && code) onVerify()
      return
    }
    if (e.key === 'Backspace' && !boxes[index] && index > 0) {
      e.preventDefault()
      const next = [...boxes]
      next[index - 1] = ''
      commit(next)
      focusBox(index - 1)
      return
    }
    if (e.key === 'ArrowLeft' && index > 0) focusBox(index - 1)
    if (e.key === 'ArrowRight' && index < OTP_LENGTH - 1) focusBox(index + 1)
  }

  const handlePaste = (index: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (digits) distribute(digits, index)
  }

  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <label
          htmlFor="otp-code-0"
          style={{
            display: 'block',
            marginBottom: 8,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text-secondary)',
          }}
        >
          {t('loginVerificationCode')}
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          {boxes.map((digit, i) => (
            <input
              key={i}
              id={`otp-code-${i}`}
              ref={(el) => {
                inputsRef.current[i] = el
              }}
              type="text"
              className="login-input"
              style={{
                flex: 1,
                minWidth: 0,
                padding: '14px 0',
                borderRadius: tokens.radius.lg,
                border: '1px solid var(--glass-border-light)',
                background: 'var(--color-bg-tertiary)',
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.xl,
                fontWeight: tokens.typography.fontWeight.semibold,
                outline: 'none',
                textAlign: 'center',
              }}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={(e) => handlePaste(i, e)}
              aria-label={`${t('loginVerificationCode')} ${i + 1}`}
              autoFocus={i === 0}
            />
          ))}
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          {t('loginCodeValidFor')}
        </div>
      </div>
      <button
        onClick={onVerify}
        disabled={loading || code.length < OTP_LENGTH}
        className="login-button"
        style={{
          width: '100%',
          padding: '14px 16px',
          borderRadius: tokens.radius.lg,
          border: 'none',
          background:
            loading || code.length < OTP_LENGTH
              ? 'var(--color-accent-primary-20)'
              : 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
          color: tokens.colors.white,
          fontWeight: 700,
          fontSize: 16,
          cursor: loading || code.length < OTP_LENGTH ? 'not-allowed' : 'pointer',
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {loading && <Spinner />}
        {loading ? t('loginVerifying') : t('loginVerifyCode')}
      </button>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
        {countdown > 0 ? (
          <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
            {countdown} {t('loginCountdown')}
          </span>
        ) : (
          <button
            onClick={onResend}
            disabled={!email}
            className="link-hover"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--color-brand)',
              fontSize: 13,
              fontWeight: 600,
              cursor: !email ? 'not-allowed' : 'pointer',
              padding: 0,
            }}
          >
            {t('loginResendCode')}
          </button>
        )}
      </div>
      {onSwitchToPassword && (
        <button
          onClick={onSwitchToPassword}
          className="link-hover"
          style={{
            width: '100%',
            padding: '8px',
            border: 'none',
            background: 'transparent',
            color: 'var(--color-brand)',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
            marginBottom: 12,
          }}
        >
          {t('loginWithPassword')}
        </button>
      )}
    </>
  )
}
