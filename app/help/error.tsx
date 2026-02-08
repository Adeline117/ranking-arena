'use client'

import { useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return (
    <div style={{ minHeight: '50vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 }}>
      <h2 style={{ color: tokens.colors.text.primary, fontSize: 20, fontWeight: 700 }}>Something went wrong</h2>
      <p style={{ color: tokens.colors.text.secondary, fontSize: 14 }}>{error.message || 'An unexpected error occurred'}</p>
      <button onClick={reset} style={{ padding: '10px 24px', borderRadius: 8, background: tokens.colors.accent.brand, color: tokens.colors.white, border: 'none', cursor: 'pointer', fontWeight: 600 }}>
        Try again
      </button>
    </div>
  )
}
