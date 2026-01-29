'use client'

import React, { useState, useRef, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'

interface ShareCompareButtonProps {
  traderIds: string[]
  /** Optional ref to the comparison container element for image capture */
  comparisonRef?: React.RefObject<HTMLElement | null>
}

export default function ShareCompareButton({ traderIds, comparisonRef }: ShareCompareButtonProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [showMenu, setShowMenu] = useState(false)
  const [generating, setGenerating] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/compare?ids=${traderIds.join(',')}`
    : ''

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      showToast(t('compareShareCopied'), 'success')
    } catch {
      // Fallback
      const ta = document.createElement('textarea')
      ta.value = shareUrl
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      showToast(t('compareShareCopied'), 'success')
    }
    setShowMenu(false)
  }, [shareUrl, showToast, t])

  const handleGenerateImage = useCallback(async () => {
    if (!comparisonRef?.current) {
      // Fallback: just copy link
      handleCopyLink()
      return
    }

    setGenerating(true)
    try {
      // Dynamic import html2canvas only when needed
      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(comparisonRef.current, {
        backgroundColor: '#0a0a0f',
        scale: 2,
        logging: false,
        useCORS: true,
      })

      // Convert to blob and trigger download
      canvas.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `ranking-arena-compare-${Date.now()}.png`
        a.click()
        URL.revokeObjectURL(url)
        showToast('Image downloaded!', 'success')
      }, 'image/png')
    } catch (err) {
      console.error('Failed to generate image:', err)
      // Fallback to link
      handleCopyLink()
    } finally {
      setGenerating(false)
      setShowMenu(false)
    }
  }, [comparisonRef, handleCopyLink, showToast])

  if (traderIds.length < 2) return null

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setShowMenu(!showMenu)}
        icon={
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        }
      >
        {t('compareShareBtn')}
      </Button>

      {showMenu && (
        <>
          {/* Backdrop */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onClick={() => setShowMenu(false)}
          />
          {/* Menu */}
          <div
            ref={menuRef}
            style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: 8,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              padding: 4,
              minWidth: 180,
              zIndex: 100,
              boxShadow: tokens.shadow.lg,
            }}
          >
            <button
              onClick={handleCopyLink}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 12px',
                border: 'none',
                background: 'transparent',
                color: tokens.colors.text.primary,
                fontSize: 13,
                borderRadius: tokens.radius.md,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={e => e.currentTarget.style.background = tokens.colors.bg.hover}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              {t('compareShareBtn')} (Link)
            </button>

            <button
              onClick={handleGenerateImage}
              disabled={generating}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 12px',
                border: 'none',
                background: 'transparent',
                color: tokens.colors.text.primary,
                fontSize: 13,
                borderRadius: tokens.radius.md,
                cursor: generating ? 'wait' : 'pointer',
                textAlign: 'left',
                opacity: generating ? 0.6 : 1,
              }}
              onMouseEnter={e => { if (!generating) e.currentTarget.style.background = tokens.colors.bg.hover }}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              {generating ? '...' : t('compareShareImage')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
