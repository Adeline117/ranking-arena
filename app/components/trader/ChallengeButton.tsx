'use client'

/**
 * ChallengeButton — adds a "PK" button to the trader profile header.
 *
 * When clicked it opens a modal where the user can:
 * 1. Search for an opponent by name
 * 2. Select an opponent from results
 * 3. Copy the PK link or share directly to X/Twitter
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'

interface TraderSearchResult {
  id: string
  type: string
  title: string
  subtitle?: string
  href: string
  avatar?: string | null
  meta?: Record<string, unknown>
}

interface ChallengeButtonProps {
  /** The current trader's handle (challenger) */
  handle: string
  /** The current trader's source/platform */
  source?: string
  /** Display name of the current trader */
  displayName?: string
}

const BASE_URL =
  typeof window !== 'undefined' ? window.location.origin : 'https://www.arenafi.org'

export default function ChallengeButton({
  handle,
  source,
  displayName,
}: ChallengeButtonProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TraderSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<TraderSearchResult | null>(null)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const router = useRouter()

  // Focus search input when modal opens
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
    if (!open) {
      setQuery('')
      setResults([])
      setSelected(null)
      setCopied(false)
    }
  }, [open])

  // Debounced search
  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([])
      return
    }
    setLoading(true)
    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(q)}&limit=8`
      )
      if (!res.ok) throw new Error('Search failed')
      const data = await res.json()
      const traders: TraderSearchResult[] =
        data?.data?.results?.traders || []
      setResults(traders)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  const handleQueryChange = (value: string) => {
    setQuery(value)
    setSelected(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(value), 350)
  }

  // Build PK URL once an opponent is selected
  const buildPKUrl = (opponentHandle: string): string => {
    const params = new URLSearchParams()
    if (source) params.set('platform', source)
    const paramStr = params.toString()
    const path = `/pk/${encodeURIComponent(handle)}/${encodeURIComponent(opponentHandle)}`
    return `${BASE_URL}${path}${paramStr ? `?${paramStr}` : ''}`
  }

  const pkUrl = selected ? buildPKUrl(selected.title) : ''
  const opponentName = selected?.title || ''

  const goToPK = () => {
    if (!selected) return
    const path = `/pk/${encodeURIComponent(handle)}/${encodeURIComponent(selected.title)}${
      source ? `?platform=${encodeURIComponent(source)}` : ''
    }`
    router.push(path)
    setOpen(false)
  }

  const shareToX = () => {
    const challengerName = displayName || handle
    const text = `${challengerName} vs ${opponentName} — who is the better trader? Check the Arena PK:`
    const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pkUrl)}`
    window.open(shareUrl, '_blank', 'noopener,noreferrer,width=600,height=450')
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(pkUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(true)}
        title="Challenge another trader to a PK"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 14px',
          borderRadius: 8,
          background: 'color-mix(in srgb, var(--color-medal-gold) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--color-medal-gold) 30%, transparent)',
          color: 'var(--color-medal-gold)',
          minHeight: 44,
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
          letterSpacing: 0.5,
          transition: 'all 0.2s ease',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'color-mix(in srgb, var(--color-medal-gold) 15%, transparent)'
          e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--color-medal-gold) 60%, transparent)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'color-mix(in srgb, var(--color-medal-gold) 8%, transparent)'
          e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--color-medal-gold) 30%, transparent)'
        }}
      >
        {/* Crossed swords icon */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.5 17.5L3 6V3h3l11.5 11.5" />
          <path d="M13 19l6-6" />
          <path d="M2 14l6-6" />
          <path d="M20.5 16.5l1 1-6.5 6.5-4-4" />
          <path d="M3.5 3.5l1 1 6.5 6.5-4 4-6.5-6.5 1-1" />
        </svg>
        PK
      </button>

      {/* Modal overlay */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Challenge a trader to PK"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 400,
            background: 'var(--color-backdrop-heavy, rgba(0,0,0,0.75))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
          }}
        >
          <div
            style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--glass-border-medium)',
              borderRadius: 16,
              padding: '28px 24px',
              width: '100%',
              maxWidth: 480,
              boxShadow: '0 24px 64px var(--color-overlay-dark, rgba(0,0,0,0.6))',
              position: 'relative',
            }}
          >
            {/* Close button */}
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              style={{
                position: 'absolute',
                top: 16,
                right: 16,
                background: 'none',
                border: 'none',
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                padding: 12,
                display: 'flex',
                alignItems: 'center',
                minWidth: 44,
                minHeight: 44,
                justifyContent: 'center',
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            {/* Header */}
            <div style={{ marginBottom: 20 }}>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-tertiary)',
                  letterSpacing: 3,
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}
              >
                ARENA PK
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  color: 'var(--color-text-primary)',
                }}
              >
                Challenge a Trader
              </div>
              <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                Search for an opponent to compare stats head-to-head
              </div>
            </div>

            {/* Search input */}
            {!selected && (
              <div style={{ position: 'relative', marginBottom: 12 }}>
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Search trader by name..."
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 36px 10px 14px',
                    borderRadius: 8,
                    background: 'var(--glass-bg-light)',
                    border: '1px solid var(--glass-border-medium)',
                    color: 'var(--color-text-primary)',
                    fontSize: 14,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
                {loading && (
                  <div
                    style={{
                      position: 'absolute',
                      right: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      width: 16,
                      height: 16,
                      border: '2px solid var(--color-accent-primary-30)',
                      borderTopColor: 'var(--color-accent-primary, #8b6fa8)',
                      borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                )}
              </div>
            )}

            {/* Search results */}
            {!selected && results.length > 0 && (
              <div
                style={{
                  maxHeight: 220,
                  overflowY: 'auto',
                  borderRadius: 8,
                  border: '1px solid var(--glass-border-light)',
                  marginBottom: 16,
                }}
              >
                {results.map((r, i) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      setSelected(r)
                      setQuery('')
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 14px',
                      background: 'transparent',
                      border: 'none',
                      borderBottom:
                        i < results.length - 1
                          ? '1px solid var(--glass-border-light)'
                          : 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background =
                        'var(--color-accent-primary-10)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    {/* Avatar initial */}
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: '50%',
                        background:
                          'linear-gradient(135deg, var(--color-accent-primary, #8b6fa8) 0%, #6366f1 100%)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 14,
                        fontWeight: 800,
                        color: 'var(--color-on-accent, #fff)',
                        flexShrink: 0,
                      }}
                    >
                      {r.title.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: 'var(--color-text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.title}
                      </div>
                      {r.subtitle && (
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--color-text-tertiary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {r.subtitle}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* No results */}
            {!selected && query.length > 1 && !loading && results.length === 0 && (
              <div
                style={{
                  textAlign: 'center',
                  padding: '16px',
                  color: 'var(--color-text-tertiary)',
                  fontSize: 13,
                  marginBottom: 12,
                }}
              >
                No traders found for &quot;{query}&quot;
              </div>
            )}

            {/* Selected opponent — show PK actions */}
            {selected && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Selected trader chip */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    background: 'var(--color-accent-primary-10)',
                    border: '1px solid var(--color-accent-primary-30)',
                    borderRadius: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: '50%',
                        background:
                          'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 13,
                        fontWeight: 800,
                        color: 'var(--color-on-accent, #fff)',
                      }}
                    >
                      {selected.title.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        {selected.title}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        Opponent selected
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelected(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--color-text-tertiary)',
                      cursor: 'pointer',
                      fontSize: 13,
                      padding: 4,
                    }}
                  >
                    Change
                  </button>
                </div>

                {/* PK link */}
                <div
                  style={{
                    padding: '8px 12px',
                    background: 'var(--glass-bg-light)',
                    border: '1px solid var(--glass-border-light)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--color-text-tertiary)',
                    wordBreak: 'break-all',
                    fontFamily: 'monospace',
                  }}
                >
                  {pkUrl}
                </div>

                {/* Action buttons */}
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  {/* Go to PK page */}
                  <button
                    onClick={goToPK}
                    style={{
                      flex: 1,
                      minWidth: 120,
                      padding: '10px 16px',
                      borderRadius: 8,
                      background:
                        'linear-gradient(135deg, var(--color-accent-primary-30) 0%, rgba(99,102,241,0.3) 100%)',
                      border: '1px solid var(--color-accent-primary-40)',
                      color: 'var(--color-text-primary)',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    View PK
                  </button>

                  {/* Share to X */}
                  <button
                    onClick={shareToX}
                    style={{
                      flex: 1,
                      minWidth: 120,
                      padding: '10px 16px',
                      borderRadius: 8,
                      background: 'var(--glass-bg-light)',
                      border: '1px solid var(--glass-border-medium)',
                      color: 'var(--color-text-primary)',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.258 5.622 5.907-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                    Share on X
                  </button>

                  {/* Copy link */}
                  <button
                    onClick={copyLink}
                    style={{
                      width: '100%',
                      padding: '8px 14px',
                      borderRadius: 8,
                      background: 'transparent',
                      border: '1px solid var(--glass-border-light)',
                      color: copied ? 'var(--color-accent-success)' : 'var(--color-text-tertiary)',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      transition: 'color 0.2s',
                    }}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {copied ? (
                        <polyline points="20 6 9 17 4 12" />
                      ) : (
                        <>
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </>
                      )}
                    </svg>
                    {copied ? 'Copied!' : 'Copy Link'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
