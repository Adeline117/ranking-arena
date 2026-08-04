'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
import { Box, Text } from '../base'
import { useToast } from './Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '../Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  isReportEvidenceCleanupAcknowledgement,
  readOwnedReportEvidenceRef,
  readReportEvidenceUploadAcknowledgement,
  readReportSubmissionAcknowledgement,
} from '@/lib/reports/client-contract'

export type ReportContentType = 'post' | 'comment' | 'message' | 'user'
export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'inappropriate'
  | 'misinformation'
  | 'fraud'
  | 'other'

interface ReportModalProps {
  isOpen: boolean
  onClose: () => void
  contentType: ReportContentType
  contentId: string
  /** @deprecated Authorization is read from canonical useAuthSession state. */
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

interface ReportEvidenceUpload {
  previewUrl: string
  evidenceRef: string
  ownerId: string
}

async function cleanupEvidenceRequest(evidenceRef: string, accessToken: string): Promise<void> {
  try {
    const response = await fetch('/api/upload', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...getCsrfHeaders(),
      },
      body: JSON.stringify({ evidence_ref: evidenceRef }),
    })
    if (response.status === 404 || response.status === 409) return
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok || !isReportEvidenceCleanupAcknowledgement(payload)) {
      logger.warn('Report evidence cleanup failed:', { status: response.status })
    }
  } catch (error) {
    // TTL cleanup is authoritative; this request only shortens orphan life.
    logger.warn('Report evidence cleanup failed:', error)
  }
}

export default function ReportModal({
  isOpen,
  onClose,
  contentType,
  contentId,
  targetName,
}: ReportModalProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { accessToken, userId } = useAuthSession()
  const [reason, setReason] = useState<ReportReason | null>(null)
  const [description, setDescription] = useState('')
  const [images, setImages] = useState<ReportEvidenceUpload[]>([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const closingRef = useRef(false)
  const imagesRef = useRef<ReportEvidenceUpload[]>([])
  const generationRef = useRef(0)
  const operationSequenceRef = useRef(0)
  const uploadOperationRef = useRef<number | null>(null)
  const submitOperationRef = useRef<number | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const submitAbortRef = useRef<AbortController | null>(null)
  const scopeKeyRef = useRef<string | null>(null)
  const authRef = useRef({ accessToken, viewerId: userId?.toLowerCase() ?? null })
  authRef.current = { accessToken, viewerId: userId?.toLowerCase() ?? null }
  const scopeRef = useRef({
    isOpen,
    viewerId: userId?.toLowerCase() ?? null,
    contentType,
    contentId: contentId.toLowerCase(),
  })
  scopeRef.current = {
    isOpen,
    viewerId: userId?.toLowerCase() ?? null,
    contentType,
    contentId: contentId.toLowerCase(),
  }
  imagesRef.current = images

  useEffect(() => {
    const viewerId = userId?.toLowerCase() ?? null
    const nextScopeKey = isOpen ? `${viewerId ?? 'anonymous'}:${contentType}:${contentId}` : null
    const previousScopeKey = scopeKeyRef.current
    scopeKeyRef.current = nextScopeKey
    if (isOpen) closingRef.current = false

    if (previousScopeKey !== null && previousScopeKey !== nextScopeKey) {
      generationRef.current += 1
      uploadAbortRef.current?.abort()
      submitAbortRef.current?.abort()
      uploadOperationRef.current = null
      submitOperationRef.current = null
      setUploading(false)
      setSubmitting(false)
      setReason(null)
      setDescription('')
      const pendingEvidence = imagesRef.current
      imagesRef.current = []
      setImages([])
      const currentAuth = authRef.current
      if (currentAuth.accessToken && currentAuth.viewerId === viewerId) {
        for (const image of pendingEvidence) {
          if (image.ownerId === viewerId) {
            void cleanupEvidenceRequest(image.evidenceRef, currentAuth.accessToken)
          }
        }
      }
    }
  }, [contentId, contentType, isOpen, userId]) // access-token refresh preserves one viewer scope

  useEffect(
    () => () => {
      generationRef.current += 1
      uploadAbortRef.current?.abort()
      submitAbortRef.current?.abort()
    },
    []
  )

  const cleanupEvidence = useCallback(
    async (evidenceRef: string) => {
      if (!accessToken) return
      await cleanupEvidenceRequest(evidenceRef, accessToken)
    },
    [accessToken]
  )

  const closeAndCleanup = useCallback(() => {
    closingRef.current = true
    generationRef.current += 1
    uploadAbortRef.current?.abort()
    submitAbortRef.current?.abort()
    uploadOperationRef.current = null
    submitOperationRef.current = null
    const pendingEvidence = imagesRef.current
    imagesRef.current = []
    setImages([])
    setUploading(false)
    setSubmitting(false)
    setReason(null)
    setDescription('')
    void Promise.allSettled(pendingEvidence.map((image) => cleanupEvidence(image.evidenceRef)))
    onClose()
  }, [cleanupEvidence, onClose])

  const MIN_DESC_LENGTH = 15
  const MAX_IMAGES = 4

  const contentTypeLabel = t(
    CONTENT_TYPE_KEYS[contentType] as keyof typeof import('@/lib/i18n/en').default
  )

  const handleSubmit = async () => {
    if (submitOperationRef.current !== null) return
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

    const viewerId = userId?.toLowerCase() ?? null
    if (
      !accessToken ||
      !viewerId ||
      !isOpen ||
      images.some((image) => image.ownerId !== viewerId)
    ) {
      showToast(t('reportFailed'), 'error')
      return
    }

    const operationId = ++operationSequenceRef.current
    submitOperationRef.current = operationId
    const generation = generationRef.current
    const operationScope = {
      viewerId,
      contentType,
      contentId: contentId.toLowerCase(),
    }
    const evidenceRefs = images.map((image) => image.evidenceRef)
    const controller = new AbortController()
    submitAbortRef.current?.abort()
    submitAbortRef.current = controller
    setSubmitting(true)
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          content_type: contentType,
          content_id: operationScope.contentId,
          reason,
          description: description.trim() || null,
          images: evidenceRefs,
        }),
        signal: controller.signal,
      })

      const data: unknown = await res.json().catch(() => null)
      const acknowledgement =
        res.status === 201
          ? readReportSubmissionAcknowledgement(data, {
              reporterId: operationScope.viewerId,
              contentType: operationScope.contentType,
              contentId: operationScope.contentId,
              reason,
              evidenceRefs,
            })
          : null
      const currentScope = scopeRef.current
      if (
        controller.signal.aborted ||
        generation !== generationRef.current ||
        submitOperationRef.current !== operationId ||
        !currentScope.isOpen ||
        currentScope.viewerId !== operationScope.viewerId ||
        currentScope.contentType !== operationScope.contentType ||
        currentScope.contentId !== operationScope.contentId
      ) {
        return
      }

      if (!acknowledgement) {
        showToast(t('reportFailed'), 'error')
        return
      }

      showToast(t('reportSubmitted'), 'success')
      closingRef.current = true
      submitOperationRef.current = null
      imagesRef.current = []
      setSubmitting(false)
      setReason(null)
      setDescription('')
      setImages([])
      onClose()
    } catch (error) {
      if (submitOperationRef.current === operationId && !controller.signal.aborted) {
        logger.error('Report error:', error)
        showToast(t('networkError'), 'error')
      }
    } finally {
      if (submitOperationRef.current === operationId) {
        submitOperationRef.current = null
        setSubmitting(false)
      }
    }
  }

  const handleEvidenceUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || uploadOperationRef.current !== null || submitOperationRef.current !== null) return
    if (file.size > 2 * 1024 * 1024) {
      showToast(t('reportEvidenceTooLarge'), 'warning')
      return
    }

    const viewerId = userId?.toLowerCase() ?? null
    if (!accessToken || !viewerId || !isOpen || imagesRef.current.length >= MAX_IMAGES) {
      showToast(t('uploadFailedRetry'), 'error')
      return
    }

    const operationId = ++operationSequenceRef.current
    uploadOperationRef.current = operationId
    const generation = generationRef.current
    const operationScope = {
      viewerId,
      contentType,
      contentId: contentId.toLowerCase(),
    }
    const operationToken = accessToken
    const controller = new AbortController()
    uploadAbortRef.current?.abort()
    uploadAbortRef.current = controller
    setUploading(true)
    let uploadedEvidenceRef: string | null = null

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('bucket', 'reports')
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${operationToken}`,
          ...getCsrfHeaders(),
        },
        body: formData,
        signal: controller.signal,
      })
      const payload: unknown = await res.json().catch(() => null)
      uploadedEvidenceRef = readOwnedReportEvidenceRef(payload, operationScope.viewerId)
      const acknowledgement =
        res.status === 200
          ? readReportEvidenceUploadAcknowledgement(
              payload,
              operationScope.viewerId,
              process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
            )
          : null
      if (!acknowledgement) throw new Error('Evidence upload returned an invalid response')

      const currentScope = scopeRef.current
      if (
        controller.signal.aborted ||
        generation !== generationRef.current ||
        uploadOperationRef.current !== operationId ||
        !currentScope.isOpen ||
        currentScope.viewerId !== operationScope.viewerId ||
        currentScope.contentType !== operationScope.contentType ||
        currentScope.contentId !== operationScope.contentId ||
        closingRef.current
      ) {
        await cleanupEvidenceRequest(acknowledgement.evidenceRef, operationToken)
        uploadedEvidenceRef = null
        return
      }

      if (
        imagesRef.current.length >= MAX_IMAGES ||
        imagesRef.current.some((image) => image.evidenceRef === acknowledgement.evidenceRef)
      ) {
        await cleanupEvidenceRequest(acknowledgement.evidenceRef, operationToken)
        uploadedEvidenceRef = null
        throw new Error('Evidence upload returned a duplicate or excess reference')
      }

      const nextImages = [
        ...imagesRef.current,
        {
          previewUrl: acknowledgement.previewUrl,
          evidenceRef: acknowledgement.evidenceRef,
          ownerId: operationScope.viewerId,
        },
      ]
      imagesRef.current = nextImages
      setImages(nextImages)
      uploadedEvidenceRef = null
    } catch (error) {
      if (uploadedEvidenceRef) {
        await cleanupEvidenceRequest(uploadedEvidenceRef, operationToken)
      }
      if (
        uploadOperationRef.current === operationId &&
        !controller.signal.aborted &&
        generation === generationRef.current
      ) {
        logger.error('Report evidence upload failed:', error)
        showToast(t('uploadFailedRetry'), 'error')
      }
    } finally {
      if (uploadOperationRef.current === operationId) {
        uploadOperationRef.current = null
        setUploading(false)
      }
    }
  }

  const handleRemoveEvidence = (index: number) => {
    if (submitting) return
    const removed = imagesRef.current[index]
    if (!removed) return
    const nextImages = imagesRef.current.filter((_, imageIndex) => imageIndex !== index)
    imagesRef.current = nextImages
    setImages(nextImages)
    void cleanupEvidence(removed.evidenceRef)
  }

  return (
    <ModalOverlay
      open={isOpen}
      onClose={closeAndCleanup}
      label={t('reportTitle').replace('{type}', contentTypeLabel)}
    >
      <div
        style={{
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
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                <line x1="4" y1="22" x2="4" y2="15" />
              </svg>
            </Box>
            <Text id="report-modal-title" size="lg" weight="bold">
              {t('reportTitle').replace('{type}', contentTypeLabel)}
            </Text>
          </Box>
          <button
            type="button"
            onClick={closeAndCleanup}
            aria-label={t('cancel')}
            style={{
              width: 44,
              height: 44,
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
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
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
                <span
                  style={{
                    color: tokens.colors.text.primary,
                    fontWeight: tokens.typography.fontWeight.semibold,
                  }}
                >
                  {targetName}
                </span>
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
                  type="button"
                  key={option.value}
                  onClick={() => setReason(option.value)}
                  disabled={submitting}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[3],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    background:
                      reason === option.value
                        ? 'var(--color-accent-error-20)'
                        : tokens.colors.bg.secondary,
                    border:
                      reason === option.value
                        ? '1px solid var(--color-accent-error)'
                        : `1px solid ${tokens.colors.border.primary}`,
                    borderRadius: tokens.radius.md,
                    color: tokens.colors.text.primary,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    textAlign: 'left',
                    minHeight: 44,
                  }}
                >
                  <Box
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      border:
                        reason === option.value
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
                  <Text size="sm">
                    {t(option.key as keyof typeof import('@/lib/i18n/en').default)}
                  </Text>
                </button>
              ))}
            </Box>
          </Box>

          {/* Description */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
              {t('reportDetailsLabel')}{' '}
              <span style={{ color: 'var(--color-accent-error)' }}>*</span>
            </Text>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('reportDetailsPlaceholder')}
              aria-label={t('reportDetailsLabel')}
              maxLength={1000}
              rows={4}
              disabled={submitting}
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
            <Text
              size="xs"
              style={{
                marginTop: tokens.spacing[1],
                textAlign: 'right',
                color:
                  description.trim().length < MIN_DESC_LENGTH
                    ? 'var(--color-accent-error)'
                    : tokens.colors.text.tertiary,
              }}
            >
              {description.trim().length}/{MIN_DESC_LENGTH} {t('reportMinChars')} ·{' '}
              {description.length}/1000
            </Text>
          </Box>

          {/* Image Upload */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
              {t('reportScreenshot')} <span style={{ color: 'var(--color-accent-error)' }}>*</span>
              <span
                style={{
                  fontWeight: tokens.typography.fontWeight.normal,
                  color: tokens.colors.text.tertiary,
                  marginLeft: tokens.spacing[1],
                  fontSize: tokens.typography.fontSize.xs,
                }}
              >
                ({images.length}/{MAX_IMAGES})
              </span>
            </Text>

            <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
              {images.map((image, i) => (
                <Box
                  key={image.evidenceRef}
                  style={{
                    position: 'relative',
                    width: 72,
                    height: 72,
                    borderRadius: tokens.radius.md,
                    overflow: 'hidden',
                    border: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  <Image
                    src={image.previewUrl}
                    alt="Report evidence"
                    fill
                    sizes="80px"
                    loading="lazy"
                    unoptimized
                    referrerPolicy="no-referrer"
                    style={{ objectFit: 'cover' }}
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveEvidence(i)}
                    disabled={submitting}
                    aria-label={`Remove image ${i + 1}`}
                    style={{
                      position: 'absolute',
                      top: tokens.spacing[0.5],
                      right: tokens.spacing[0.5],
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: 'var(--color-backdrop-medium)',
                      border: 'none',
                      color: tokens.colors.white,
                      fontSize: tokens.typography.fontSize.xs,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <span aria-hidden="true">X</span>
                  </button>
                </Box>
              ))}

              {images.length < MAX_IMAGES && !submitting && (
                <label
                  style={{
                    width: 72,
                    height: 72,
                    borderRadius: tokens.radius.md,
                    border: `2px dashed ${tokens.colors.border.secondary}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: uploading ? 'wait' : 'pointer',
                    opacity: uploading ? 0.5 : 1,
                    flexDirection: 'column',
                    gap: tokens.spacing[0.5],
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={tokens.colors.text.tertiary}
                    strokeWidth="2"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.tertiary,
                    }}
                  >
                    {uploading ? '...' : t('upload')}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    disabled={uploading || submitting || !accessToken || !userId}
                    onChange={handleEvidenceUpload}
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
              type="button"
              onClick={closeAndCleanup}
              style={{
                flex: 1,
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                color: tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                cursor: 'pointer',
                transition: 'all 0.2s',
                minHeight: 44,
              }}
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={
                submitting ||
                !reason ||
                description.trim().length < MIN_DESC_LENGTH ||
                images.length === 0
              }
              style={{
                flex: 1,
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                background:
                  reason && description.trim().length >= MIN_DESC_LENGTH && images.length > 0
                    ? 'var(--color-accent-error)'
                    : tokens.colors.bg.tertiary,
                border: 'none',
                borderRadius: tokens.radius.md,
                color:
                  reason && description.trim().length >= MIN_DESC_LENGTH && images.length > 0
                    ? 'var(--color-on-accent)'
                    : tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                cursor:
                  submitting ||
                  !reason ||
                  description.trim().length < MIN_DESC_LENGTH ||
                  images.length === 0
                    ? 'not-allowed'
                    : 'pointer',
                opacity: submitting ? 0.6 : 1,
                transition: 'all 0.2s',
                minHeight: 44,
              }}
            >
              {submitting ? `⏳ ${t('reportSubmitting')}` : t('reportSubmit')}
            </button>
          </Box>
        </Box>
      </div>
    </ModalOverlay>
  )
}
