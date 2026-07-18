'use client'

/**
 * TraderShareActions — the quiz-grade "share your rank" viral loop, brought to
 * trader profile pages.
 *
 * Replicates the gold-standard quiz result ShareActions pattern:
 *   - live OG rank-card preview (via /api/og/rank)
 *   - one-tap X / Telegram / WhatsApp / native-share
 *   - downloadable rank card
 *   - localized brag caption
 *
 * Referral wiring: when a LOGGED-IN user shares, their referral code
 * (`/api/referral` → handle) is appended as `?ref=<code>` to the shared URL so
 * every brag doubles as a referral link. Guests share without a ref (still
 * works). The `/share/rank/[trader_key]` route preserves `ref` through its
 * redirect to `/wrapped/[handle]`, where the root layout's pre-hydration
 * capture stores it — closing the loop.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { platformLabel, formatRoiShort } from '@/lib/constants/platform-labels'

interface TraderShareActionsProps {
  handle: string
  displayName?: string
  platform?: string
  rank?: number | null
  roi?: number | null
  arenaScore?: number | null
  /** Timeframe window for the shared card. Defaults to 90d (roi is 90D). */
  window?: string
}

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1200 1227"
      fill="currentColor"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6944H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z" />
    </svg>
  )
}

function TelegramIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  )
}

function WhatsAppIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  )
}

function CopyIcon() {
  return (
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
  )
}

function DownloadIcon() {
  return (
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
  )
}

function ShareNodesIcon() {
  return (
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
  )
}

export default function TraderShareActions({
  handle,
  displayName,
  platform,
  rank,
  roi,
  arenaScore,
  window: windowProp = '90d',
}: TraderShareActionsProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { userId, getAuthHeadersAsync } = useAuthSession()

  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [canNativeShare, setCanNativeShare] = useState(false)
  const [ogLoaded, setOgLoaded] = useState(false)
  // Current user's referral code (their handle). Fetched lazily on first open.
  const [referralCode, setReferralCode] = useState<string | null>(null)
  const referralFetched = useRef(false)

  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && 'share' in navigator)
  }, [])

  // Lazily resolve the sharer's referral code when the panel opens (logged-in
  // only). Best-effort: on failure we simply share without a ref.
  useEffect(() => {
    if (!open || !userId || referralFetched.current) return
    referralFetched.current = true
    let cancelled = false
    ;(async () => {
      try {
        const headers = await getAuthHeadersAsync()
        const res = await fetch('/api/referral', { headers })
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled && json?.referral_code) setReferralCode(String(json.referral_code))
      } catch {
        // best-effort — share still works without ref
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, userId, getAuthHeadersAsync])

  const name = displayName || handle
  const platLabel = platformLabel(platform)
  const windowParam = windowProp.toLowerCase()

  const buildShareUrl = useCallback(() => {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://www.arenafi.org'
    const params = new URLSearchParams()
    if (platform) params.set('platform', platform)
    params.set('window', windowParam)
    // Every logged-in brag is a referral link.
    if (referralCode) params.set('ref', referralCode)
    return `${base}/share/rank/${encodeURIComponent(handle)}?${params}`
  }, [handle, platform, windowParam, referralCode])

  // OG rank-card preview / download source (query params only, no DB).
  const buildOgUrl = useCallback(() => {
    const params = new URLSearchParams()
    params.set('name', name)
    params.set('handle', handle)
    if (platform) params.set('platform', platform)
    params.set('window', windowParam)
    if (rank != null && rank > 0) params.set('rank', String(rank))
    if (roi != null) params.set('roi', String(roi))
    if (arenaScore != null) params.set('score', String(arenaScore))
    return `/api/og/rank?${params}`
  }, [name, handle, platform, windowParam, rank, roi, arenaScore])

  // Localized brag caption built from factual parts (adapts to available data).
  const buildCaption = useCallback(() => {
    const url = buildShareUrl()
    const lead = t('traderShareLead').replace('{name}', name)
    const facts: string[] = []
    if (rank != null && rank > 0) {
      facts.push(
        platLabel
          ? t('traderShareFactRankOn')
              .replace('{rank}', String(rank))
              .replace('{platform}', platLabel)
          : t('traderShareFactRank').replace('{rank}', String(rank))
      )
    }
    if (arenaScore != null) {
      facts.push(t('traderShareFactScore').replace('{score}', String(Math.round(arenaScore))))
    }
    if (roi != null) {
      facts.push(t('traderShareFactRoi').replace('{roi}', formatRoiShort(roi)))
    }
    const headline = facts.length ? `${lead} — ${facts.join(' · ')}` : lead
    return { headline, url, text: `${headline}\n\n${url}` }
  }, [buildShareUrl, t, name, rank, platLabel, arenaScore, roi])

  const handleShareX = useCallback(() => {
    const { text } = buildCaption()
    window.open(
      `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
      '_blank',
      'noopener,noreferrer,width=600,height=500'
    )
  }, [buildCaption])

  const handleShareTelegram = useCallback(() => {
    const { headline, url } = buildCaption()
    window.open(
      `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(headline)}`,
      '_blank',
      'noopener,noreferrer'
    )
  }, [buildCaption])

  const handleShareWhatsApp = useCallback(() => {
    const { text } = buildCaption()
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer')
  }, [buildCaption])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildShareUrl())
      showToast(t('linkCopied'), 'success')
    } catch {
      showToast(t('copyFailed'), 'error')
    }
  }, [buildShareUrl, showToast, t])

  const handleNativeShare = useCallback(async () => {
    const { headline, url } = buildCaption()
    if (navigator.share) {
      try {
        await navigator.share({ title: t('traderSharePanelTitle'), text: headline, url })
      } catch {
        // user cancelled — ignore
      }
    }
  }, [buildCaption, t])

  const handleDownload = useCallback(async () => {
    setDownloading(true)
    try {
      const res = await fetch(buildOgUrl())
      if (!res.ok) {
        throw new Error(`Rank card download failed (${res.status})`)
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `arena-${handle}-rank.png`
      a.click()
      URL.revokeObjectURL(objectUrl)
    } catch {
      showToast(t('quizDownloadFailed'), 'error')
    } finally {
      setDownloading(false)
    }
  }, [buildOgUrl, handle, showToast, t])

  // --- styles ---
  const triggerBtn: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
    borderRadius: tokens.radius.md,
    border: `1px solid ${tokens.colors.accent.primary}`,
    background: 'var(--glass-bg-medium)',
    color: tokens.colors.accent.primary,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    transition: `all ${tokens.transition.base}`,
    whiteSpace: 'nowrap',
    lineHeight: 1.2,
  }

  const secondaryBtn: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--glass-border-light)',
    background: 'var(--color-bg-tertiary)',
    color: 'var(--color-text-primary)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    transition: `all ${tokens.transition.base}`,
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
    transition: `all ${tokens.transition.base}`,
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('traderShareBtn')}
        aria-label={t('traderShareBtn')}
        style={triggerBtn}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--glass-bg-heavy)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--glass-bg-medium)'
        }}
      >
        <XIcon size={13} />
        <span className="hide-below-sm">{t('traderShareBtn')}</span>
      </button>

      <ModalOverlay
        open={open}
        onClose={() => setOpen(false)}
        label={t('traderSharePanelTitle')}
        maxWidth={440}
        portal
      >
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              fontSize: 17,
              fontWeight: 800,
              color: 'var(--color-text-primary)',
              letterSpacing: '-0.01em',
            }}
          >
            {t('traderSharePanelTitle')}
          </div>

          {/* OG rank-card preview */}
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
            {!ogLoaded && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background:
                    'linear-gradient(90deg, var(--color-bg-tertiary) 25%, var(--color-bg-secondary) 50%, var(--color-bg-tertiary) 75%)',
                  backgroundSize: '200% 100%',
                  animation: 'traderOgSkeleton 1.8s ease-in-out infinite',
                }}
              />
            )}
            <img
              src={buildOgUrl()}
              alt={`${name} Arena rank card preview`}
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

          {/* Primary CTA: Share on X */}
          <button
            type="button"
            onClick={handleShareX}
            aria-label={t('shareOnX')}
            style={{
              width: '100%',
              padding: '13px 20px',
              borderRadius: 10,
              border: 'none',
              background: 'var(--color-text-primary)',
              color: 'var(--color-bg-primary)',
              fontSize: 15,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              letterSpacing: '-0.01em',
            }}
          >
            <XIcon size={16} />
            {t('shareOnX')}
          </button>

          {/* Secondary row: Telegram / WhatsApp / Copy */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <button
              type="button"
              onClick={handleShareTelegram}
              aria-label="Telegram"
              style={secondaryBtn}
            >
              <TelegramIcon />
              <span className="hide-below-sm">Telegram</span>
            </button>
            <button
              type="button"
              onClick={handleShareWhatsApp}
              aria-label="WhatsApp"
              style={secondaryBtn}
            >
              <WhatsAppIcon />
              <span className="hide-below-sm">WhatsApp</span>
            </button>
            <button
              type="button"
              onClick={handleCopy}
              aria-label={t('copyShareLink')}
              style={secondaryBtn}
            >
              <CopyIcon />
              <span className="hide-below-sm">{t('copyShareLink')}</span>
            </button>
          </div>

          {/* Tertiary row: Save Card / Native share */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: canNativeShare ? '1fr 1fr' : '1fr',
              gap: 6,
            }}
          >
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              aria-label={t('traderShareSaveCard')}
              style={{ ...tertiaryBtn, opacity: downloading ? 0.5 : 1 }}
            >
              <DownloadIcon />
              {downloading ? '…' : t('traderShareSaveCard')}
            </button>
            {canNativeShare && (
              <button
                type="button"
                onClick={handleNativeShare}
                aria-label={t('traderShareNative')}
                style={tertiaryBtn}
              >
                <ShareNodesIcon />
                {t('traderShareNative')}
              </button>
            )}
          </div>

          <style>{`
            @keyframes traderOgSkeleton {
              0% { background-position: 200% 0; }
              100% { background-position: -200% 0; }
            }
          `}</style>
        </div>
      </ModalOverlay>
    </>
  )
}
