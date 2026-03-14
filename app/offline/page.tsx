'use client'

import { useState, useEffect } from 'react'
import { t } from '@/lib/i18n'
import { tokens } from '@/lib/design-tokens'

interface CachedTrader {
  nickname?: string
  exchange?: string
  pnl_7d?: number
}

/**
 * Offline page
 * Shown when user is offline and no cached page is available
 */
export default function OfflinePage() {
  const [cachedTraders, setCachedTraders] = useState<CachedTrader[]>([])

  useEffect(() => {
    // Try to load cached leaderboard data from Cache API
    async function loadCachedData() {
      try {
        const cache = await caches.open('ranking-arena-v3')
        const keys = await cache.keys()
        const tradersReq = keys.find((r) => r.url.includes('/api/traders'))
        if (tradersReq) {
          const resp = await cache.match(tradersReq)
          if (resp) {
            const data = await resp.json()
            const list = Array.isArray(data) ? data : data?.data
            if (Array.isArray(list)) {
              setCachedTraders(list.slice(0, 5))
            }
          }
        }
      } catch {
        // Intentionally swallowed: offline page cached data is best-effort, empty state is acceptable
      }
    }
    loadCachedData()
  }, [])

  const handleRetry = () => {
    window.location.reload()
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--spacing-4, 1rem)',
        backgroundColor: 'var(--color-bg-primary, #0B0A10)',
        color: 'var(--color-text-primary, #EDEDED)',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center',
          padding: 'var(--spacing-8, 2rem)',
        }}
      >
        {/* Offline icon */}
        <div
          style={{
            width: '64px',
            height: '64px',
            margin: '0 auto 1.5rem',
            borderRadius: '50%',
            backgroundColor: 'var(--color-bg-tertiary, #1C1926)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-text-tertiary, #8E8E9E)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
        </div>

        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 'bold',
            marginBottom: '0.75rem',
            color: 'var(--color-text-primary, #EDEDED)',
          }}
        >
          {t('youAreOffline')}
        </h1>

        <p
          style={{
            fontSize: '0.875rem',
            color: 'var(--color-text-secondary, #A8A8B3)',
            marginBottom: '2rem',
            lineHeight: 1.6,
          }}
        >
          {t('checkNetworkAndRetryOffline')}
        </p>

        <button
          onClick={handleRetry}
          style={{
            padding: '0.75rem 2rem',
            fontSize: '0.875rem',
            fontWeight: '500',
            color: 'var(--color-on-accent)',
            backgroundColor: 'var(--color-brand, #8b6fa8)',
            border: 'none',
            borderRadius: tokens.radius.md,
            cursor: 'pointer',
            transition: 'opacity 0.2s',
            width: '100%',
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.opacity = '0.85'
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.opacity = '1'
          }}
        >
          {t('retryConnection')}
        </button>

        {/* Cached leaderboard data */}
        {cachedTraders.length > 0 && (
          <div
            style={{
              marginTop: '2rem',
              padding: '1rem',
              backgroundColor: 'var(--color-bg-secondary, #14121C)',
              borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-border-primary, #2A2836)',
              textAlign: 'left',
            }}
          >
            <p
              style={{
                fontSize: '0.75rem',
                fontWeight: '600',
                color: 'var(--color-text-tertiary, #8E8E9E)',
                marginBottom: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {t('cachedLeaderboard') || 'Last cached leaderboard'}
            </p>
            {cachedTraders.map((trader, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.5rem 0',
                  borderTop:
                    i > 0
                      ? '1px solid var(--color-border-primary, #2A2836)'
                      : 'none',
                }}
              >
                <span
                  style={{
                    fontSize: '0.8125rem',
                    color: 'var(--color-text-primary, #EDEDED)',
                  }}
                >
                  {i + 1}. {trader.nickname || 'Trader'}
                </span>
                {trader.pnl_7d != null && (
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: '500',
                      color:
                        trader.pnl_7d >= 0
                          ? 'var(--color-success, #2fe57d)'
                          : 'var(--color-error, #ff7c7c)',
                    }}
                  >
                    {trader.pnl_7d >= 0 ? '+' : ''}
                    {trader.pnl_7d.toFixed(1)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <p
          style={{
            fontSize: '0.75rem',
            color: 'var(--color-text-tertiary, #6B6B7B)',
            marginTop: '2rem',
          }}
        >
          {t('arenaTagline')}
        </p>
      </div>
    </div>
  )
}
