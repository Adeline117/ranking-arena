'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useToast } from './Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '../Providers/LanguageProvider'
import { logger } from '@/lib/logger'

export type ReportContentType = 'post' | 'comment' | 'message' | 'user'
export type ReportReason = 'spam' | 'harassment' | 'inappropriate' | 'misinformation' | 'fraud' | 'other'

interface ReportModalProps {
  isOpen: boolean
  onClose: () => void
  contentType: ReportContentType
  contentId: string
  accessToken: string
  /** Optional: display name of what's being reported */
  targetName?: string
}

type ReasonOption = { value: ReportReason; key: string }
const REASON_OPTIONS: ReasonOption[] = [
  { value: 'spam', key: 'reportReasonSpam' },
  { value: 'harassment', key: 'reportReasonHarassment' },
  { value: 'inappropriate', key: 'reportReasonInappropriate' },
  { value: 'misinformation', key: 'reportReasonMisinformation' },
  { value: 'fraud', key: 'reportReasonFraud' },
  { value: 'other', key: 'reportReasonOther' },
]

const CONTENT_TYPE_KEYS: Record<ReportContentType, string> = {
  post: 'reportContentPost',
  comment: 'reportContentComment',
  message: 'reportContentMessage',
  user: 'reportContentUser',
}

export default function ReportModal({
  isOpen,
  onClose,
  contentType,
  contentId,
  accessToken,
  targetName,
}: ReportModalProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [reason, setReason] = useState<ReportReason | null>(null)
  const [description, setDescription] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const MIN_DESC_LENGTH = 15
  const MAX_IMAGES = 4
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const contentTypeLabel = t(CONTENT_TYPE_KEYS[contentType] as keyof typeof import('@/lib/i18n/en').default)

  // Scroll lock when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  // Focus trap + escape key for modal
  useEffect(() => {
    if (!isOpen) return
    previousFocusRef.current = document.activeElement as HTMLElement

    const timer = setTimeout(() => {
      if (modalRef.current) {
        const firstFocusable = modalRef.current.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        firstFocusable?.focus()
      }
    }, 50)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus() }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus() }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [isOpen, onClose])

  const handleSubmit = async () => {
    if (!reason) {
      showToast(t('selectReportReason'), 'warning')
      return
    }

    if (!description.trim() || description.trim().length < MIN_DESC_LENGTH) {
      showToast(t('reportMinDescription'), 'warning')
      return
    }

    if (images.length === 0) {
      showToast(t('reportNeedImage'), 'warning')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          content_type: contentType,
          content_id: contentId,
          reason,
          description: description.trim() || null,
          images,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        showToast(data.error || t('reportFailed'), 'error')
        return
      }

      showToast(t('reportSubmitted'), 'success')
      onClose()
      // Reset form
      setReason(null)
      setDescription('')
      setImages([])
    } catch (error) {
      logger.error('Report error:', error)
      showToast(t('networkError'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <>
      {/* Overlay */}
      <Box
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--color-backdrop)',
          zIndex: tokens.zIndex.modal,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: tokens.spacing[4],
        }}
      >
        {/* Modal */}
        <Box
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-modal-title"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            maxWidth: 420,
            maxHeight: 'calc(100vh - 40px)',
            background: tokens.colors.bg.primary,
            borderRadius: tokens.radius.xl,
            boxShadow: 'var(--shadow-elevated)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column' as const,
          }}
        >
          {/* Header */}
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <Box style={{ color: 'var(--color-accent-error)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                  <line x1="4" y1="22" x2="4" y2="15" />
                </svg>
              </Box>
              <Text id="report-modal-title" size="lg" weight="bold">
                {t('reportTitle').replace('{type}', contentTypeLabel)}
              </Text>
            </Box>
            <button
              onClick={onClose}
              aria-label={t('cancel')}
              style={{
                width: 32,
                height: 32,
                borderRadius: tokens.radius.full,
                border: 'none',
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </Box>

          {/* Content - scrollable */}
          <Box style={{ padding: tokens.spacing[5], overflowY: 'auto', flex: 1 }}>
            {/* Target info */}
            {targetName && (
              <Box
                style={{
                  padding: tokens.spacing[3],
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.md,
                  marginBottom: tokens.spacing[4],
                }}
              >
                <Text size="sm" color="secondary">
                  {t('reportTarget')}
                  <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>{targetName}</span>
                </Text>
              </Box>
            )}

            {/* Reason selection */}
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('reportReasonLabel')}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {REASON_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setReason(option.value)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[3],
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      background: reason === option.value
                        ? 'var(--color-accent-error-20)'
                        : tokens.colors.bg.secondary,
                      border: reason === option.value
                        ? '1px solid var(--color-accent-error)'
                        : `1px solid ${tokens.colors.border.primary}`,
                      borderRadius: tokens.radius.md,
                      color: tokens.colors.text.primary,
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      textAlign: 'left',
                    }}
                  >
                    <Box
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        border: reason === option.value
                          ? '2px solid var(--color-accent-error)'
                          : `2px solid ${tokens.colors.border.secondary}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {reason === option.value && (
                        <Box
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: 'var(--color-accent-error)',
                          }}
                        />
                      )}
                    </Box>
                    <Text size="sm">{t(option.key as keyof typeof import('@/lib/i18n/en').default)}</Text>
                  </button>
                ))}
              </Box>
            </Box>

            {/* Description */}
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('reportDetailsLabel')} <span style={{ color: 'var(--color-accent-error)' }}>*</span>
              </Text>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('reportDetailsPlaceholder')}
                aria-label={t('reportDetailsLabel')}
                maxLength={1000}
                rows={4}
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  resize: 'vertical',
                  outline: 'none',
                  transition: 'border-color 0.2s',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--color-accent-error)'
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = tokens.colors.border.primary
                }}
              />
              <Text size="xs" style={{ marginTop: 4, textAlign: 'right', color: description.trim().length < MIN_DESC_LENGTH ? 'var(--color-accent-error)' : tokens.colors.text.tertiary }}>
                {description.trim().length}/{MIN_DESC_LENGTH} {t('reportMinChars')} · {description.length}/1000
              </Text>
            </Box>

            {/* Image Upload */}
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('reportScreenshot')} <span style={{ color: 'var(--color-accent-error)' }}>*</span>
                <span style={{ fontWeight: 400, color: tokens.colors.text.tertiary, marginLeft: 4, fontSize: 12 }}>
                  ({images.length}/{MAX_IMAGES})
                </span>
              </Text>

              <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                {images.map((img, i) => (
                  <Box key={i} style={{ position: 'relative', width: 72, height: 72, borderRadius: tokens.radius.md, overflow: 'hidden', border: `1px solid ${tokens.colors.border.primary}` }}>
                    <Image src={img} alt="Report evidence" fill sizes="80px" loading="lazy" style={{ objectFit: 'cover' }} />
                    <button
                      onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                      aria-label={`Remove image ${i + 1}`}
                      style={{
                        position: 'absolute', top: 2, right: 2, width: 20, height: 20,
                        borderRadius: '50%', background: 'var(--color-backdrop-medium)', border: 'none',
                        color: tokens.colors.white, fontSize: 12, cursor: 'pointer', display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                      }}
                    ><span aria-hidden="true">X</span></button>
                  </Box>
                ))}

                {images.length < MAX_IMAGES && (
                  <label style={{
                    width: 72, height: 72, borderRadius: tokens.radius.md,
                    border: `2px dashed ${tokens.colors.border.secondary}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: uploading ? 'wait' : 'pointer', opacity: uploading ? 0.5 : 1,
                    flexDirection: 'column', gap: 2,
                  }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                      <circle cx="8.5" cy="8.5" r="1.5"/>
                      <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>{uploading ? '...' : t('upload')}</span>
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      disabled={uploading}
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        if (file.size > 5 * 1024 * 1024) {
                          showToast(t('fileTooLarge'), 'warning')
                          return
                        }
                        setUploading(true)
                        try {
                          const formData = new FormData()
                          formData.append('file', file)
                          formData.append('bucket', 'reports')
                          const res = await fetch('/api/upload', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${accessToken}` },
                            body: formData,
                          })
                          if (res.ok) {
                            const { url } = await res.json()
                            setImages(prev => [...prev, url])
                          } else {
                            // Fallback to base64 if upload API not available
                            const reader = new FileReader()
                            reader.onload = () => {
                              setImages(prev => [...prev, reader.result as string])
                            }
                            reader.readAsDataURL(file)
                          }
                        } catch {
                          // Fallback to base64
                          const reader = new FileReader()
                          reader.onload = () => {
                            setImages(prev => [...prev, reader.result as string])
                          }
                          reader.readAsDataURL(file)
                        } finally {
                          setUploading(false)
                        }
                        e.target.value = ''
                      }}
                    />
                  </label>
                )}
              </Box>
            </Box>

            {/* Notice */}
            <Box
              style={{
                padding: tokens.spacing[3],
                background: 'var(--color-orange-bg-light)',
                borderRadius: tokens.radius.md,
                marginBottom: tokens.spacing[4],
              }}
            >
              <Text size="xs" color="secondary" style={{ lineHeight: 1.5 }}>
                {t('reportNotice')}
              </Text>
            </Box>

            {/* Actions */}
            <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
              <button
                onClick={onClose}
                style={{
                  flex: 1,
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !reason || description.trim().length < MIN_DESC_LENGTH || images.length === 0}
                style={{
                  flex: 1,
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  background: reason && description.trim().length >= MIN_DESC_LENGTH && images.length > 0 ? 'var(--color-accent-error)' : tokens.colors.bg.tertiary,
                  border: 'none',
                  borderRadius: tokens.radius.md,
                  color: reason && description.trim().length >= MIN_DESC_LENGTH && images.length > 0 ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 600,
                  cursor: submitting || !reason || description.trim().length < MIN_DESC_LENGTH || images.length === 0 ? 'not-allowed' : 'pointer',
                  opacity: submitting ? 0.6 : 1,
                  transition: 'all 0.2s',
                }}
              >
                {submitting ? `⏳ ${t('reportSubmitting')}` : t('reportSubmit')}
              </button>
            </Box>
          </Box>
        </Box>
      </Box>
    </>
  )
}
