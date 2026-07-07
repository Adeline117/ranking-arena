'use client'

import { useEffect, useState, useCallback } from 'react'
import type { PersonalityType } from '../../components/types'
import { alpha } from '@/lib/design-tokens'

interface ShareActionsProps {
  type: PersonalityType
  matchPercent: number
  resultUrl: string
  tr: (key: string) => string
  /** Current quiz language — forwarded to the OG image so the shared card's
   *  personality name matches the page (e.g. 叙事猎人, not THE NARRATIVE TRADER). */
  lang: string
}

export default function ShareActions({
  type,
  matchPercent,
  resultUrl,
  tr,
  lang,
}: ShareActionsProps) {
  // Local toast — quiz runs outside (app) Providers so useToast() is unavailable
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const showToast = useCallback((msg: string, _type?: string) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 2500)
  }, [])
  const [downloading, setDownloading] = useState(false)
  const [canNativeShare, setCanNativeShare] = useState(false)
  const [ogLoaded, setOgLoaded] = useState(false)

  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && 'share' in navigator)
  }, [])

  const masterName = tr(type.master.nameKey)
  // Challenge-format share text for crypto community virality
  const shareText =
    tr('quizShareChallenge') !== 'quizShareChallenge'
      ? tr('quizShareChallenge')
          .replace('{type}', tr(type.nameKey))
          .replace('{master}', masterName)
          .replace('{match}', String(matchPercent))
          .replace('{url}', resultUrl)
      : `Just scored ${matchPercent}% ${tr(type.nameKey)} on Arena's trader personality test. My trading soulmate: ${masterName}. Bet you can't beat my match ${resultUrl}`

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resultUrl)
      showToast(tr('quizCopied'), 'success')
    } catch {
      showToast(tr('quizCopyFailed'), 'error')
    }
  }

  const handleShareX = () => {
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleShareTelegram = () => {
    const url = `https://t.me/share/url?url=${encodeURIComponent(resultUrl)}&text=${encodeURIComponent(shareText)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleShareWhatsApp = () => {
    const url = `https://wa.me/?text=${encodeURIComponent(shareText)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const ogUrl = `/api/og/quiz?type=${type.id}&match=${matchPercent}&lang=${encodeURIComponent(lang)}`
      const res = await fetch(ogUrl)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `arena-${type.id}-personality.png`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      showToast(tr('quizDownloadFailed'), 'error')
    } finally {
      setDownloading(false)
    }
  }

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: tr('quizTitle'), text: shareText, url: resultUrl })
      } catch {
        // User cancelled — ignore
      }
    }
  }

  const handleChallengeFriend = async () => {
    const challengeUrl = `${resultUrl.split('/result')[0]}?challenger=${type.id}&challengerMatch=${matchPercent}`
    const challengeText = `Hey! I just found out I'm a ${tr(type.nameKey)} trader (${matchPercent}% match). Curious what type you are: ${challengeUrl}`
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Challenge: What trader type are you?',
          text: challengeText,
          url: challengeUrl,
        })
      } catch {
        /* cancelled */
      }
    } else {
      // eslint-disable-next-line no-restricted-syntax
      await navigator.clipboard.writeText(challengeText).catch(() => {})
      showToast(tr('quizCopied'), 'success')
    }
  }

  const ogImageUrl = `/api/og/quiz?type=${type.id}&match=${matchPercent}&lang=${encodeURIComponent(lang)}`

  // --- Hover / active helpers for inline-styled buttons ---
  const addHover = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = 'translateY(-1px)'
    e.currentTarget.style.background = 'var(--color-bg-secondary)'
    e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,0.08)'
  }, [])
  const removeHover = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = 'translateY(0)'
    e.currentTarget.style.background = 'var(--color-bg-tertiary)'
    e.currentTarget.style.boxShadow = 'none'
  }, [])
  const addActive = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = 'scale(0.98)'
  }, [])
  const removeActive = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = 'translateY(-1px)'
  }, [])

  // --- Shared style tokens ---
  const secondaryBtn: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid var(--glass-border-light)',
    background: 'var(--color-bg-tertiary)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    color: 'var(--color-text-primary)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
  }

  const tertiaryBtn: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    padding: '8px 10px',
    borderRadius: 10,
    border: '1px solid var(--glass-border-light)',
    background: 'transparent',
    color: 'var(--color-text-tertiary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* ── OG Card Preview ─────────────────────────────────────── */}
      <div
        style={{
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid var(--glass-border-light)',
          aspectRatio: '1200 / 630',
          width: '100%',
          background: 'var(--color-bg-tertiary)',
          position: 'relative',
        }}
      >
        {/* Skeleton pulse while loading */}
        {!ogLoaded && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'linear-gradient(90deg, var(--color-bg-tertiary) 25%, var(--color-bg-secondary) 50%, var(--color-bg-tertiary) 75%)',
              backgroundSize: '200% 100%',
              animation: 'quizOgSkeleton 1.8s ease-in-out infinite',
            }}
          />
        )}
        <img
          src={ogImageUrl}
          alt={`${tr(type.nameKey)} personality card preview`}
          loading="lazy"
          onLoad={() => setOgLoaded(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            opacity: ogLoaded ? 1 : 0,
            transition: 'opacity 0.4s ease',
          }}
        />
      </div>

      {/* ── Primary CTA: Share on X ─────────────────────────────── */}
      <button
        type="button"
        onClick={handleShareX}
        aria-label="Share on X"
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'translateY(-2px)'
          e.currentTarget.style.boxShadow = '0 6px 24px rgba(0,0,0,0.35)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'translateY(0)'
          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)'
        }}
        onMouseDown={(e) => {
          e.currentTarget.style.transform = 'scale(0.98)'
        }}
        onMouseUp={(e) => {
          e.currentTarget.style.transform = 'translateY(-2px)'
        }}
        style={{
          width: '100%',
          padding: '14px 20px',
          borderRadius: 10,
          border: 'none',
          background: '#000',
          color: '#fff',
          fontSize: 15,
          fontWeight: 700,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          letterSpacing: '-0.01em',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        {tr('quizShareOnX') !== 'quizShareOnX' ? tr('quizShareOnX') : 'Share on X'}
      </button>

      {/* ── Secondary Row: TG / WA / Copy Link ──────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <button
          type="button"
          onClick={handleShareTelegram}
          aria-label="Share on Telegram"
          onMouseEnter={addHover}
          onMouseLeave={removeHover}
          onMouseDown={addActive}
          onMouseUp={removeActive}
          style={secondaryBtn}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
          </svg>
          Telegram
        </button>
        <button
          type="button"
          onClick={handleShareWhatsApp}
          aria-label="Share on WhatsApp"
          onMouseEnter={addHover}
          onMouseLeave={removeHover}
          onMouseDown={addActive}
          onMouseUp={removeActive}
          style={secondaryBtn}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
          </svg>
          WhatsApp
        </button>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={tr('quizCopyLink')}
          onMouseEnter={addHover}
          onMouseLeave={removeHover}
          onMouseDown={addActive}
          onMouseUp={removeActive}
          style={secondaryBtn}
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
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {tr('quizCopyLink')}
        </button>
      </div>

      {/* ── Tertiary Row: Download / Challenge / Share ───────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: canNativeShare ? '1fr 1fr 1fr' : '1fr 1fr',
          gap: 6,
          marginTop: 2,
        }}
      >
        {/* Download — muted, borderless feel */}
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          aria-label={tr('quizDownloadCard')}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-bg-secondary)'
            e.currentTarget.style.transform = 'translateY(-1px)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.transform = 'translateY(0)'
          }}
          onMouseDown={addActive}
          onMouseUp={removeActive}
          style={{
            ...tertiaryBtn,
            opacity: downloading ? 0.5 : 1,
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
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {downloading ? '...' : tr('quizDownloadCard')}
        </button>

        {/* Challenge — type-colored border, special feel */}
        <button
          type="button"
          onClick={handleChallengeFriend}
          aria-label="Challenge a friend"
          onMouseEnter={(e) => {
            e.currentTarget.style.background = `${alpha(type.color, 6)}`
            e.currentTarget.style.transform = 'translateY(-1px)'
            e.currentTarget.style.boxShadow = `0 4px 14px ${alpha(type.color, 9)}`
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.transform = 'translateY(0)'
            e.currentTarget.style.boxShadow = 'none'
          }}
          onMouseDown={addActive}
          onMouseUp={removeActive}
          style={{
            ...tertiaryBtn,
            border: `1px solid ${alpha(type.color, 25)}`,
            color: type.color,
            fontWeight: 600,
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
            aria-hidden="true"
          >
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="19" y1="8" x2="19" y2="14" />
            <line x1="22" y1="11" x2="16" y2="11" />
          </svg>
          Challenge
        </button>

        {/* Native Share — only when supported */}
        {canNativeShare && (
          <button
            type="button"
            onClick={handleNativeShare}
            aria-label={tr('quizShare')}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-bg-secondary)'
              e.currentTarget.style.transform = 'translateY(-1px)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.transform = 'translateY(0)'
            }}
            onMouseDown={addActive}
            onMouseUp={removeActive}
            style={tertiaryBtn}
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
              aria-hidden="true"
            >
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            {tr('quizShare')}
          </button>
        )}
      </div>

      {/* Skeleton animation keyframe (injected once) */}
      <style>{`
        @keyframes quizOgSkeleton {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      {/* Local toast — standalone quiz has no ToastProvider */}
      {toastMsg && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '10px 20px',
            borderRadius: 10,
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--glass-border-light)',
            color: 'var(--color-text-primary)',
            fontSize: 13,
            fontWeight: 600,
            zIndex: 9999,
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          }}
        >
          {toastMsg}
        </div>
      )}
    </div>
  )
}
