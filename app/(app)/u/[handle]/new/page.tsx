'use client'

import { features } from '@/lib/features'
import { redirect } from 'next/navigation'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import { compressImage } from '@/lib/utils/image-compress'
import { DynamicStickerPicker } from '@/app/components/ui/Dynamic'
import { trackEvent } from '@/lib/analytics/track'
import type { Sticker } from '@/lib/stickers'
import { logger } from '@/lib/logger'
import { VisibilitySelector } from '@/app/components/post/components/VisibilitySelector'
import { ContentWarningToggle } from '@/app/components/post/components/ContentWarningToggle'
import {
  MentionAutocomplete,
  useMentionAutocomplete,
} from '@/app/components/post/components/MentionAutocomplete'
import type { PostVisibility } from '@/lib/types/post'
import { renderContentWithControls } from './components/ContentPreview'
import { ImageUploader, VideoUploader } from './components/MediaUploader'
import { PollEditor } from './components/PollEditor'
import type { UploadedImage, UploadedVideo, PollOption } from './types'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import {
  bindPostCreateOperation,
  publishPostAtomic,
  type BoundPostCreateOperation,
} from '@/lib/posts/post-create-client'
import {
  readPostImageUploadAcknowledgement,
  readPostMediaUploadError,
  readPostVideoUploadAcknowledgement,
  type PostVideoUploadAcknowledgement,
} from '@/lib/posts/post-media-upload-contract'
import {
  moveMarkdownImage,
  removeMarkdownImage,
  removeMarkdownVideoMarkers,
} from '@/lib/posts/markdown-images'
import {
  isPostDraftMeaningful,
  postDraftStorageKey,
  readPostDraft,
  removePostDraft,
  savePostDraft,
  type ProfilePostDraftData,
  type ProfilePostDraftScope,
} from '@/lib/posts/post-draft-storage'
import { useUnsavedChangesGuard } from '@/lib/hooks/useUnsavedChangesGuard'
import { TITLE_MAX_LENGTH, CONTENT_MAX_LENGTH } from './types'

export default function NewPostPage() {
  if (!features.social) redirect('/')

  const params = useParams<{ handle: string }>()
  const handle = params.handle as string
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const submitRef = useRef(false)
  const publishOperationRef = useRef<BoundPostCreateOperation | null>(null)
  const [cursorPosition, setCursorPosition] = useState<number | null>(null)

  const [userId, setUserId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showStickerPicker, setShowStickerPicker] = useState(false)
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null)
  const [hydratedDraftScopeKey, setHydratedDraftScopeKey] = useState<string | null>(null)
  const [pollEnabled, setPollEnabled] = useState(false)
  const [pollOptions, setPollOptions] = useState<PollOption[]>([
    { text: '', votes: 0 },
    { text: '', votes: 0 },
  ])
  const [pollDuration, setPollDuration] = useState(0)
  const [pollType, setPollType] = useState<'single' | 'multiple'>('single')
  const [draggedImageIndex, setDraggedImageIndex] = useState<number | null>(null)
  const [titleTouched, setTitleTouched] = useState(false)
  const titleHadInputRef = useRef(false)
  const [visibility, setVisibility] = useState<PostVisibility>('public')
  const [isSensitive, setIsSensitive] = useState(false)
  const [contentWarning, setContentWarning] = useState('')
  const videoInputRef = useRef<HTMLInputElement>(null)
  const [videos, setVideos] = useState<UploadedVideo[]>([])
  const [videoUploading, setVideoUploading] = useState(false)
  const [videoUploadProgress, setVideoUploadProgress] = useState(0)
  const mentionAutocomplete = useMentionAutocomplete()

  const draftScope = useMemo<ProfilePostDraftScope | null>(
    () =>
      userId
        ? {
            ownerId: userId,
            destination: { type: 'profile', handle },
          }
        : null,
    [handle, userId]
  )
  const draftScopeKey = useMemo(
    () => (draftScope ? postDraftStorageKey(draftScope) : null),
    [draftScope]
  )
  const draftData = useMemo<ProfilePostDraftData>(
    () => ({
      title,
      content,
      images,
      videos,
      pollEnabled,
      pollOptions,
      pollType,
      pollDuration,
      visibility: visibility === 'followers' ? 'followers' : 'public',
      isSensitive,
      contentWarning,
    }),
    [
      title,
      content,
      images,
      videos,
      pollEnabled,
      pollOptions,
      pollType,
      pollDuration,
      visibility,
      isSensitive,
      contentWarning,
    ]
  )
  const hasUnsavedDraft = isPostDraftMeaningful({ type: 'profile', handle }, draftData)
  // Guard text, media, poll, visibility, and content-warning changes.
  useUnsavedChangesGuard(hasUnsavedDraft && !loading)

  const resetDraftForm = useCallback(() => {
    setTitle('')
    setContent('')
    setImages([])
    setVideos([])
    setPollEnabled(false)
    setPollOptions([
      { text: '', votes: 0 },
      { text: '', votes: 0 },
    ])
    setPollType('single')
    setPollDuration(0)
    setVisibility('public')
    setIsSensitive(false)
    setContentWarning('')
    setDraftSavedAt(null)
    setTitleTouched(false)
    titleHadInputRef.current = false
    publishOperationRef.current = null
  }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    })
  }, [])

  // Load draft from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!draftScope || !draftScopeKey) {
      if (hydratedDraftScopeKey !== null) {
        resetDraftForm()
        setHydratedDraftScopeKey(null)
      }
      return
    }
    if (hydratedDraftScopeKey === draftScopeKey) return

    if (hydratedDraftScopeKey !== null) resetDraftForm()
    const draft = readPostDraft(localStorage, draftScope)
    if (draft && isPostDraftMeaningful(draftScope.destination, draft)) {
      setTitle(draft.title)
      setContent(draft.content)
      setImages(draft.images)
      setVideos(draft.videos)
      setPollEnabled(draft.pollEnabled)
      setPollOptions(draft.pollOptions)
      setPollType(draft.pollType)
      setPollDuration(draft.pollDuration)
      setVisibility(draft.visibility)
      setIsSensitive(draft.isSensitive)
      setContentWarning(draft.contentWarning)
      showToast(t('draftRestored'), 'info')
    }
    setHydratedDraftScopeKey(draftScopeKey)
  }, [draftScope, draftScopeKey, hydratedDraftScopeKey, resetDraftForm, showToast, t])

  // Auto-save draft to localStorage (debounced)
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !draftScope ||
      !draftScopeKey ||
      hydratedDraftScopeKey !== draftScopeKey
    ) {
      return
    }

    const saveTimer = setTimeout(() => {
      if (isPostDraftMeaningful(draftScope.destination, draftData)) {
        if (!savePostDraft(localStorage, draftScope, draftData)) return
        const now = new Date()
        setDraftSavedAt(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      } else {
        removePostDraft(localStorage, draftScope)
        setDraftSavedAt(null)
      }
    }, 1000)

    return () => clearTimeout(saveTimer)
  }, [draftData, draftScope, draftScopeKey, hydratedDraftScopeKey])

  // Clear draft after successful publish
  const clearDraft = useCallback(() => {
    if (typeof window !== 'undefined' && draftScope) {
      removePostDraft(localStorage, draftScope)
    }
  }, [draftScope])

  // Image upload handler
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    if (images.length + files.length > 9) {
      showToast(t('maxImages'), 'warning')
      return
    }

    setUploading(true)
    const newImages: UploadedImage[] = []

    for (const file of Array.from(files)) {
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
      if (!allowedTypes.includes(file.type)) {
        showToast(`${file.name} ${t('formatNotSupported')}`, 'error')
        continue
      }

      if (file.size > 5 * 1024 * 1024) {
        showToast(`${file.name} ${t('fileTooLarge')}`, 'error')
        continue
      }

      try {
        // Compress image before upload (resize to 1920px, 85% quality)
        const compressed = await compressImage(file)
        const formData = new FormData()
        formData.append('file', compressed)
        formData.append('purpose', 'post_image')
        formData.append('userId', userId)

        // /api/posts/upload-image is withAuth (Bearer header only) — 401'd without the token
        const uploadToken = await tokenRefreshCoordinator.getValidToken()
        const response = await fetch('/api/posts/upload-image', {
          method: 'POST',
          headers: {
            ...(uploadToken ? { Authorization: `Bearer ${uploadToken}` } : {}),
            ...getCsrfHeaders(),
          },
          body: formData,
        })

        const responseBody: unknown = await response.json()

        if (!response.ok) {
          showToast(readPostMediaUploadError(responseBody) ?? t('uploadFailed'), 'error')
          continue
        }

        const acknowledgement = readPostImageUploadAcknowledgement(
          responseBody,
          userId,
          process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
        )
        if (!acknowledgement) {
          showToast(t('uploadFailed'), 'error')
          continue
        }

        newImages.push({
          url: acknowledgement.url,
          fileName: acknowledgement.fileName,
        })
      } catch (error) {
        logger.error('Upload error:', error)
        showToast(t('uploadFailed'), 'error')
      }
    }

    if (newImages.length > 0) {
      setImages((prev) => [...prev, ...newImages])
      showToast(t('uploadSuccess').replace('{count}', String(newImages.length)), 'success')
    }

    setUploading(false)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Video upload handler
  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    if (videos.length >= 1) {
      showToast(t('maxOneVideo'), 'warning')
      return
    }

    const file = files[0]

    const allowedTypes = [
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-msvideo',
      'video/x-matroska',
    ]
    if (!allowedTypes.includes(file.type)) {
      showToast(t('unsupportedVideoFormat'), 'error')
      return
    }

    const maxSize = 100 * 1024 * 1024
    if (file.size > maxSize) {
      showToast(t('videoTooLarge'), 'error')
      return
    }

    setVideoUploading(true)
    setVideoUploadProgress(0)

    try {
      const uploadToken = await tokenRefreshCoordinator.getValidToken()
      if (!uploadToken) throw new Error(t('pleaseLogin'))

      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', userId)

      const xhr = new XMLHttpRequest()

      const uploadPromise = new Promise<PostVideoUploadAcknowledgement>((resolve, reject) => {
        const onProgress = (event: ProgressEvent) => {
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100)
            setVideoUploadProgress(progress)
          }
        }

        const cleanup = () => {
          xhr.upload.removeEventListener('progress', onProgress)
          xhr.removeEventListener('load', onLoad)
          xhr.removeEventListener('error', onError)
          xhr.removeEventListener('abort', onAbort)
        }

        const onLoad = () => {
          cleanup()
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const responseBody: unknown = JSON.parse(xhr.responseText)
              const acknowledgement = readPostVideoUploadAcknowledgement(
                responseBody,
                userId,
                process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
              )
              if (!acknowledgement) throw new Error(t('parseResponseFailed'))
              resolve(acknowledgement)
            } catch {
              reject(new Error(t('parseResponseFailed')))
            }
          } else {
            try {
              const responseBody: unknown = JSON.parse(xhr.responseText)
              reject(new Error(readPostMediaUploadError(responseBody) ?? t('uploadFailed')))
            } catch {
              reject(new Error(`${t('uploadFailed')} (${xhr.status})`))
            }
          }
        }

        const onError = () => {
          cleanup()
          reject(new Error(t('networkErrorRetry')))
        }

        const onAbort = () => {
          cleanup()
          reject(new Error('Upload aborted'))
        }

        xhr.upload.addEventListener('progress', onProgress)
        xhr.addEventListener('load', onLoad)
        xhr.addEventListener('error', onError)
        xhr.addEventListener('abort', onAbort)

        xhr.open('POST', '/api/posts/upload-video')
        xhr.setRequestHeader('Authorization', `Bearer ${uploadToken}`)

        const csrfHeaders = getCsrfHeaders()
        Object.entries(csrfHeaders).forEach(([key, value]) => {
          if (value) xhr.setRequestHeader(key, value)
        })

        xhr.send(formData)
      })

      const data = await uploadPromise

      setVideos([
        {
          url: data.url,
          fileName: data.fileName,
          fileSize: data.fileSize,
        },
      ])

      const videoMarkdown = `\n[video](${data.url})\n`
      setContent((prev) => prev + videoMarkdown)

      showToast(t('videoUploadSuccess'), 'success')
    } catch (error) {
      logger.error('Video upload error:', error)
      showToast(t('videoUploadFailed'), 'error')
    } finally {
      setVideoUploading(false)
      setVideoUploadProgress(0)
      if (videoInputRef.current) {
        videoInputRef.current.value = ''
      }
    }
  }

  // Remove video
  const removeVideo = () => {
    setVideos([])
    setContent((prev) => removeMarkdownVideoMarkers(prev).content)
    showToast(t('videoRemoved'), 'info')
  }

  // Remove image
  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
  }

  // Image drag reorder
  const handleDragStart = (index: number) => {
    setDraggedImageIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedImageIndex === null || draggedImageIndex === index) return

    setImages((prev) => {
      const newImages = [...prev]
      const draggedImage = newImages[draggedImageIndex]
      newImages.splice(draggedImageIndex, 1)
      newImages.splice(index, 0, draggedImage)
      return newImages
    })
    setDraggedImageIndex(index)
  }

  const handleDragEnd = () => {
    setDraggedImageIndex(null)
  }

  // Insert image to content at cursor position
  const insertImageToContent = (url: string) => {
    const imageMarkdown = `\n![image](${url})\n`

    if (cursorPosition !== null) {
      setContent((prev) => {
        const before = prev.slice(0, cursorPosition)
        const after = prev.slice(cursorPosition)
        return before + imageMarkdown + after
      })
      setCursorPosition(cursorPosition + imageMarkdown.length)
    } else {
      setContent((prev) => prev + imageMarkdown)
    }
    showToast(t('imageInserted'), 'info')
  }

  // Move image position in content
  const moveImageInContent = (url: string, direction: 'up' | 'down') => {
    const result = moveMarkdownImage(content, url, direction)
    if (result.status === 'missing') return
    if (result.status === 'boundary') {
      showToast(direction === 'up' ? t('alreadyAtTop') : t('alreadyAtBottom'), 'info')
      return
    }

    setContent(result.content)
    showToast(direction === 'up' ? t('imageMovedUp') : t('imageMovedDown'), 'success')
  }

  // Remove image from content
  const removeImageFromContent = (url: string) => {
    const result = removeMarkdownImage(content, url)
    if (!result.removed) return
    setContent(result.content)
    showToast(t('imageRemovedFromContent'), 'info')
  }

  // Check if image is already in content
  const isImageInContent = (url: string) => {
    return content.includes(url)
  }

  // Save cursor position
  const handleTextareaSelect = () => {
    if (textareaRef.current) {
      setCursorPosition(textareaRef.current.selectionStart)
      mentionAutocomplete.handleTextChange(textareaRef.current.value, textareaRef.current)
    }
  }

  const handleSubmit = async () => {
    if (submitRef.current || loading) return

    if (!title.trim()) {
      showToast(t('pleaseEnterTitle'), 'warning')
      return
    }

    const unincludedImageMarkdown = images
      .filter((image) => !content.includes(image.url))
      .map((image) => `![image](${image.url})`)
      .join('\n')
    const finalContent = unincludedImageMarkdown
      ? `${content}\n\n${unincludedImageMarkdown}`
      : content
    if (!finalContent.trim()) {
      showToast(t('pleaseEnterContent'), 'warning')
      return
    }

    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/login'
      router.push(`/login?returnUrl=${encodeURIComponent(currentPath)}`)
      return
    }

    const capturedViewerScope = getViewerScope()
    if (capturedViewerScope.userId !== userId) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    const validPollOptions = pollOptions
      .map((option) => option.text.trim())
      .filter((option) => option.length > 0)
    if (pollEnabled && validPollOptions.length < 2) {
      showToast(t('pollMinOptions'), 'warning')
      return
    }

    submitRef.current = true
    setLoading(true)
    try {
      const decodedHandle = decodeURIComponent(handle)
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', userId)
        .maybeSingle()

      if (!isViewerScopeCurrent(capturedViewerScope)) return
      if (!profile || profile.handle !== decodedHandle) {
        showToast(t('noPermission'), 'error')
        return
      }

      const operation = bindPostCreateOperation(
        {
          title,
          content: finalContent,
          group_id: null,
          images: images.map((img) => img.url),
          poll_enabled: pollEnabled,
          ...(pollEnabled
            ? {
                poll_options: validPollOptions,
                poll_type: pollType,
                poll_duration_hours: pollDuration,
              }
            : {}),
          visibility,
          is_sensitive: isSensitive,
          content_warning: isSensitive && contentWarning ? contentWarning : null,
        },
        publishOperationRef.current
      )
      publishOperationRef.current = operation

      const result = await publishPostAtomic(operation.request, capturedViewerScope)
      if (result.status === 'superseded') return
      if (result.status === 'failed') {
        logger.error('Post creation error:', result.error)
        showToast(result.error, 'error')
        return
      }
      if (result.status === 'invalid_ack') {
        logger.error('Post creation acknowledgement rejected')
        showToast(t('createPostFailed'), 'error')
        return
      }

      publishOperationRef.current = null
      clearDraft()
      trackEvent('create_post', { has_images: images.length > 0 ? 1 : 0 })
      showToast(t('publishSuccess'), 'success')
      router.push(`/u/${encodeURIComponent(result.data.post.author_handle)}`)
    } catch (_error) {
      if (isViewerScopeCurrent(capturedViewerScope)) {
        showToast(t('publishFailed'), 'error')
      }
    } finally {
      setLoading(false)
      submitRef.current = false
    }
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
          {t('postUpdate')}
        </Text>
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
          {t('shareIdeas')}
        </Text>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {/* Title input */}
          <Box>
            <Box
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: tokens.spacing[2],
              }}
            >
              <Text size="sm" weight="bold">
                {t('titleLabel')}{' '}
                <span style={{ color: tokens.colors.accent.error, fontWeight: 400 }}>*</span>
              </Text>
              <Text
                size="xs"
                style={{
                  color:
                    title.length > TITLE_MAX_LENGTH
                      ? tokens.colors.accent.error
                      : tokens.colors.text.tertiary,
                }}
              >
                {title.length}/{TITLE_MAX_LENGTH}
              </Text>
            </Box>
            <input
              type="text"
              placeholder={t('enterTitle')}
              value={title}
              onChange={(e) => {
                titleHadInputRef.current = true
                setTitle(e.target.value.slice(0, TITLE_MAX_LENGTH))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && title.trim()) {
                  e.preventDefault()
                  textareaRef.current?.focus()
                }
              }}
              onBlur={() => {
                // Only surface the empty-title error once the user has actually
                // typed into the field. autoFocus means the very first click
                // elsewhere (e.g. dismissing the cookie banner) blurs an
                // untouched field — don't flash an error the user never caused.
                if (titleHadInputRef.current) setTitleTouched(true)
              }}
              maxLength={TITLE_MAX_LENGTH}
              autoFocus
              style={{
                width: '100%',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border:
                  '1px solid ' +
                  (title.length > TITLE_MAX_LENGTH
                    ? tokens.colors.accent.error
                    : tokens.colors.border.primary),
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.base,
                outline: 'none',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            />
            {titleTouched && !title.trim() && (
              <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: 4 }}>
                {t('pleaseEnterTitle')}
              </Text>
            )}
          </Box>

          {/* Content editor */}
          <Box>
            <Box
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: tokens.spacing[2],
              }}
            >
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <Text size="sm" weight="bold">
                  {t('contentLabel')}
                </Text>
                <Box
                  style={{
                    display: 'flex',
                    borderRadius: tokens.radius.md,
                    overflow: 'hidden',
                    border: '1px solid ' + tokens.colors.border.primary,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setShowPreview(false)}
                    style={{
                      padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                      border: 'none',
                      background: !showPreview ? tokens.colors.accent.brand : 'transparent',
                      color: !showPreview ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                      fontSize: tokens.typography.fontSize.xs,
                      cursor: 'pointer',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPreview(true)}
                    style={{
                      padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                      border: 'none',
                      borderLeft: '1px solid ' + tokens.colors.border.primary,
                      background: showPreview ? tokens.colors.accent.brand : 'transparent',
                      color: showPreview ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                      fontSize: tokens.typography.fontSize.xs,
                      cursor: 'pointer',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {t('preview')}
                  </button>
                </Box>
                {draftSavedAt && (
                  <Text size="xs" color="tertiary" style={{ color: tokens.colors.accent.success }}>
                    {t('draftSaved')} {draftSavedAt}
                  </Text>
                )}
              </Box>
              <Text
                size="xs"
                style={{
                  color:
                    content.length > CONTENT_MAX_LENGTH
                      ? tokens.colors.accent.error
                      : tokens.colors.text.tertiary,
                }}
              >
                {content.length}/{CONTENT_MAX_LENGTH}
              </Text>
            </Box>

            {showPreview ? (
              <Box
                style={{
                  width: '100%',
                  minHeight: 288,
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.md,
                  border: '2px solid ' + tokens.colors.accent.brand,
                  background: `linear-gradient(135deg, var(--color-accent-primary-08) 0%, var(--color-accent-primary-10) 100%)`,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  position: 'relative',
                }}
              >
                <Box
                  style={{
                    position: 'absolute',
                    top: -12,
                    left: 12,
                    background: tokens.colors.accent.brand,
                    color: tokens.colors.white,
                    padding: '2px 10px',
                    borderRadius: tokens.radius.full,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {t('previewMode')}
                </Box>
                {content ? (
                  renderContentWithControls(content, moveImageInContent, removeImageFromContent, t)
                ) : (
                  <Text color="tertiary">{t('previewPlaceholder')}</Text>
                )}
              </Box>
            ) : (
              <div style={{ position: 'relative' }}>
                <textarea
                  ref={textareaRef}
                  placeholder={t('enterContent')}
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value.slice(0, CONTENT_MAX_LENGTH))
                    handleTextareaSelect()
                  }}
                  onSelect={handleTextareaSelect}
                  onClick={handleTextareaSelect}
                  onKeyUp={handleTextareaSelect}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && title.trim() && !loading) {
                      e.preventDefault()
                      handleSubmit()
                    }
                  }}
                  maxLength={CONTENT_MAX_LENGTH}
                  rows={12}
                  style={{
                    width: '100%',
                    padding: tokens.spacing[4],
                    borderRadius: tokens.radius.md,
                    border:
                      '1px solid ' +
                      (content.length > CONTENT_MAX_LENGTH
                        ? tokens.colors.accent.error
                        : tokens.colors.border.primary),
                    background: tokens.colors.bg.secondary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.base,
                    outline: 'none',
                    fontFamily: tokens.typography.fontFamily.sans.join(', '),
                    resize: 'vertical',
                    lineHeight: 1.6,
                  }}
                />
                {mentionAutocomplete.showMention && (
                  <MentionAutocomplete
                    text={content}
                    cursorPosition={mentionAutocomplete.cursorPos}
                    accessToken={null}
                    onClose={mentionAutocomplete.closeMention}
                    onSelect={(selectedHandle, start, end) => {
                      const nextContent =
                        content.slice(0, start) + `@${selectedHandle} ` + content.slice(end)
                      mentionAutocomplete.closeMention()
                      if (nextContent.length > CONTENT_MAX_LENGTH) return

                      const nextCursor = start + selectedHandle.length + 2
                      setContent(nextContent)
                      setCursorPosition(nextCursor)
                      setTimeout(() => {
                        textareaRef.current?.focus()
                        textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
                      }, 0)
                    }}
                  />
                )}
              </div>
            )}
            {/* Sticker button */}
            <div style={{ position: 'relative', marginTop: tokens.spacing[2] }}>
              <button
                type="button"
                onClick={() => setShowStickerPicker((prev) => !prev)}
                style={{
                  background: 'transparent',
                  border: '1px solid ' + tokens.colors.border.primary,
                  cursor: 'pointer',
                  padding: '4px 10px',
                  borderRadius: tokens.radius.md,
                  color: showStickerPicker
                    ? tokens.colors.accent.brand
                    : tokens.colors.text.tertiary,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
                  <path d="M14 3v4a2 2 0 0 0 2 2h4" />
                </svg>
                {t('stickerButton')}
              </button>
              <DynamicStickerPicker
                isOpen={showStickerPicker}
                onClose={() => setShowStickerPicker(false)}
                onSelect={(sticker: Sticker) => {
                  setContent((prev) => prev + ('[sticker:' + sticker.id + ']'))
                  setShowStickerPicker(false)
                }}
              />
            </div>
            <Box
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: tokens.spacing[1],
              }}
            >
              <Text size="xs" color="tertiary">
                {t('mentionTip')}
              </Text>
              <Text size="xs" color="tertiary">
                Ctrl+Enter {t('quickPublish')}
              </Text>
            </Box>
          </Box>

          {/* Poll editor */}
          <PollEditor
            pollEnabled={pollEnabled}
            setPollEnabled={setPollEnabled}
            pollOptions={pollOptions}
            setPollOptions={setPollOptions}
            pollType={pollType}
            setPollType={setPollType}
            pollDuration={pollDuration}
            setPollDuration={setPollDuration}
            t={t}
          />

          {/* Visibility & Content Warning */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
              <Text size="sm" weight="bold">
                {t('visibility')}
              </Text>
              <VisibilitySelector value={visibility} onChange={setVisibility} />
            </Box>
            <ContentWarningToggle
              isSensitive={isSensitive}
              onToggle={setIsSensitive}
              contentWarning={contentWarning}
              onContentWarningChange={setContentWarning}
            />
          </Box>

          {/* Image uploader */}
          <ImageUploader
            images={images}
            uploading={uploading}
            fileInputRef={fileInputRef}
            onImageUpload={handleImageUpload}
            onRemoveImage={removeImage}
            onInsertImage={insertImageToContent}
            isImageInContent={isImageInContent}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            draggedImageIndex={draggedImageIndex}
            t={t}
          />

          {/* Video uploader */}
          <VideoUploader
            videos={videos}
            videoUploading={videoUploading}
            videoUploadProgress={videoUploadProgress}
            videoInputRef={videoInputRef}
            onVideoUpload={handleVideoUpload}
            onRemoveVideo={removeVideo}
            t={t}
          />

          <Box
            style={{
              display: 'flex',
              gap: tokens.spacing[3],
              justifyContent: 'flex-end',
              alignItems: 'center',
            }}
          >
            {draftSavedAt && (
              <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginRight: 'auto' }}>
                {t('draftSaved')} {draftSavedAt}
              </Text>
            )}
            <Button variant="ghost" size="md" onClick={() => router.back()} disabled={loading}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleSubmit}
              disabled={loading || !title.trim()}
              loading={loading}
            >
              {loading ? t('publishing') : t('publish')}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
