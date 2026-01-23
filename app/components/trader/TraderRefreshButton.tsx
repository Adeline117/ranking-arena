'use client'

/**
 * Trader Refresh Button
 * Calls POST /api/trader/:platform/:market_type/:trader_key/refresh
 * Enqueues a background refresh job (non-blocking)
 */

import { useState, useCallback } from 'react'

interface TraderRefreshButtonProps {
  platform: string
  market_type: string
  trader_key: string
  lastUpdated?: string | null
}

export function TraderRefreshButton({
  platform,
  market_type,
  trader_key,
  lastUpdated,
}: TraderRefreshButtonProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const handleRefresh = useCallback(async () => {
    if (status === 'loading') return

    setStatus('loading')
    setMessage(null)

    try {
      const response = await fetch(
        `/api/trader/${platform}/${market_type}/${trader_key}/refresh`,
        { method: 'POST' }
      )

      const data = await response.json()

      if (response.ok) {
        setStatus('success')
        setMessage(data.message || 'Refresh queued')
        // Reset after 5 seconds
        setTimeout(() => {
          setStatus('idle')
          setMessage(null)
        }, 5000)
      } else if (response.status === 503) {
        setStatus('error')
        setMessage(data.message || 'Platform temporarily unavailable')
      } else {
        setStatus('error')
        setMessage(data.error || 'Refresh failed')
      }
    } catch {
      setStatus('error')
      setMessage('Network error')
    }
  }, [platform, market_type, trader_key, status])

  // Calculate age
  const ageText = lastUpdated ? getAgeText(lastUpdated) : null

  return (
    <div className="flex items-center gap-2">
      {ageText && (
        <span className="text-xs text-gray-400">
          Updated {ageText}
        </span>
      )}
      <button
        onClick={handleRefresh}
        disabled={status === 'loading'}
        className={`
          inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
          transition-all duration-200
          ${status === 'loading'
            ? 'bg-gray-700 text-gray-400 cursor-wait'
            : status === 'success'
              ? 'bg-green-900/30 text-green-400 border border-green-500/30'
              : status === 'error'
                ? 'bg-red-900/30 text-red-400 border border-red-500/30'
                : 'bg-gray-800 text-gray-300 border border-gray-600 hover:border-blue-500/50 hover:text-blue-400'
          }
        `}
        title={message || 'Refresh trader data'}
      >
        {status === 'loading' ? (
          <>
            <RefreshSpinIcon />
            Refreshing...
          </>
        ) : status === 'success' ? (
          <>
            <CheckIcon />
            Queued
          </>
        ) : status === 'error' ? (
          <>
            <ErrorIcon />
            Failed
          </>
        ) : (
          <>
            <RefreshIcon />
            Refresh
          </>
        )}
      </button>
      {message && status === 'error' && (
        <span className="text-xs text-red-400">{message}</span>
      )}
    </div>
  )
}

function getAgeText(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime()
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Inline icons
function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 2v6h-6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 22v-6h6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RefreshSpinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
      <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  )
}
