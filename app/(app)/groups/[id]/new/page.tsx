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
import { trackEvent } from '@/lib/analytics/track'
import { compressImage } from '@/lib/utils/image-compress'
import { logger } from '@/lib/logger'
import { ContentWarningToggle } from '@/app/components/post/components/ContentWarningToggle'
import type { UploadedImage, UploadedVideo, PollOption, LinkPreview } from './types'
import {
  TITLE_MAX_LENGTH,
  MAX_IMAGES,
  MAX_VIDEO_SIZE_MB,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
} from './types'
import { CharCount, ToggleSwitch, inputStyle } from './components/FormControls'
import { ContentEditor } from './components/ContentEditor'
import { PollEditor } from './components/PollEditor'
import { ImageUploader } from './components/ImageUploader'
import { VideoUploader } from './components/VideoUploader'
import { useUnsavedChangesGuard } from '@/lib/hooks/useUnsavedChangesGuard'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { getViewerScope } from '@/lib/auth/viewer-scope'
import {
  bindPostCreateOperation,
  publishPostAtomic,
  type BoundPostCreateOperation,
} from '@/lib/posts/post-create-client'
import {
  readPostImageUploadAcknowledgement,
  readPostMediaUploadError,
  readPostVideoUploadAcknowledgement,
  type PostImageUploadAcknowledgement,
  type PostVideoUploadAcknowledgement,
} from '@/lib/posts/post-media-upload-contract'
import {
  isPostDraftMeaningful,
  postDraftStorageKey,
  readPostDraft,
  removePostDraft,
  savePostDraft,
  type GroupPostDraftData,
  type GroupPostDraftScope,
} from '@/lib/posts/post-draft-storage'
import { removeMarkdownVideoMarkers } from '@/lib/posts/markdown-images'

export default function NewGroupPostPage(): React.ReactElement {
  if (!features.social) redirect('/')

  const params = useParams<{ id: string }>()
  const groupId = params.id as string
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const submitRef = useRef(false)
  const publishOperationRef = useRef<BoundPostCreateOperation | null>(null)

  // User state
  const [userId, setUserId] = useState<string | null>(null)

  // Form state
  const [groupName, setGroupName] = useState<string>('')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showStickerPicker, setShowStickerPicker] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [hydratedDraftScopeKey, setHydratedDraftScopeKey] = useState<string | null>(null)

  // Media state
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [videos, setVideos] = useState<UploadedVideo[]>([])
  const [videoUploading, setVideoUploading] = useState(false)
  const [videoUploadProgress, setVideoUploadProgress] = useState(0)

  // Link preview state (UF15)
  const [linkPreview, setLinkPreview] = useState<LinkPreview | null>(null)
  const [linkPreviewLoading, setLinkPreviewLoading] = useState(false)
  const linkPreviewUrlRef = useRef<string | null>(null)

  // Content warning state
  const [isSensitive, setIsSensitive] = useState(false)
  const [contentWarning, setContentWarning] = useState('')

  // Poll state
  const [pollEnabled, setPollEnabled] = useState(false)
  const [pollOptions, setPollOptions] = useState<PollOption[]>([
    { text: '', votes: 0 },
    { text: '', votes: 0 },
  ])
  const [pollDuration, setPollDuration] = useState(24)
  const [pollType, setPollType] = useState<'single' | 'multiple'>('single')

  const draftScope = useMemo<GroupPostDraftScope | null>(
    () =>
      userId
        ? {
            ownerId: userId,
            destination: { type: 'group', groupId },
          }
        : null,
    [groupId, userId]
  )
  const draftScopeKey = useMemo(
    () => (draftScope ? postDraftStorageKey(draftScope) : null),
    [draftScope]
  )
  const draftData = useMemo<GroupPostDraftData>(
    () => ({
      title,
      content,
      images,
      videos,
      pollEnabled,
      pollOptions,
      pollType,
      pollDuration,
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
      isSensitive,
      contentWarning,
    ]
  )
  const hasUnsavedDraft = isPostDraftMeaningful({ type: 'group', groupId }, draftData)
  // Guard text, media, poll, and content-warning changes.
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
    setPollDuration(24)
    setIsSensitive(false)
    setContentWarning('')
    setDraftSaved(false)
    publishOperationRef.current = null
  }, [])

  useEffect(() => {
    if (!groupId) return

    supabase.auth.getUser().then(async ({ data }) => {
      setUserId(data.user?.id ?? null)

      if (!data.user) {
        const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/'
        router.push(`/login?returnUrl=${encodeURIComponent(currentPath)}`)
        return
      }

      // Check membership and mute status
      const { data: membership, error: membershipError } = await supabase
        .from('own_group_memberships')
        .select('role, muted_until')
        .eq('group_id', groupId)
        .eq('user_id', data.user.id)
        .maybeSingle()

      if (membershipError) {
        logger.error('Membership check error:', membershipError)
        showToast(t('checkMembershipFailed'), 'error')
        return
      }

      if (!membership) {
        showToast(t('mustJoinToPost'), 'warning')
        router.push(`/groups/${groupId}`)
        return
      }

      if (membership.muted_until && new Date(membership.muted_until) > new Date()) {
        showToast(t('youAreMuted'), 'warning')
        router.push(`/groups/${groupId}`)
        return
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase/t are stable; auth check runs on mount
  }, [router, groupId, showToast, language])

  // Load group name
  useEffect(() => {
    if (!groupId) return

    const loadGroupName = async () => {
      const { data } = await supabase.from('groups').select('name').eq('id', groupId).maybeSingle()

      if (data?.name) {
        setGroupName(data.name)
      }
    }

    loadGroupName()
  }, [groupId])

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

    let draftResetTimer: ReturnType<typeof setTimeout> | null = null

    const saveTimer = setTimeout(() => {
      if (isPostDraftMeaningful(draftScope.destination, draftData)) {
        if (!savePostDraft(localStorage, draftScope, draftData)) return
        setDraftSaved(true)
        draftResetTimer = setTimeout(() => setDraftSaved(false), 2000)
      } else {
        removePostDraft(localStorage, draftScope)
        setDraftSaved(false)
      }
    }, 1000)

    return () => {
      clearTimeout(saveTimer)
      if (draftResetTimer !== null) clearTimeout(draftResetTimer)
    }
  }, [draftData, draftScope, draftScopeKey, hydratedDraftScopeKey])

  // UF15: Detect URLs in content and fetch link preview
  useEffect(() => {
    const urlMatch = content.match(/https?:\/\/[^\s)]+/)
    const url = urlMatch ? urlMatch[0] : null
    if (url && url !== linkPreviewUrlRef.current) {
      linkPreviewUrlRef.current = url
      setLinkPreviewLoading(true)
      const abortController = new AbortController()
      fetch(`/api/posts/link-preview?url=${encodeURIComponent(url)}`, {
        signal: abortController.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && (data.title || data.description)) {
            setLinkPreview({ url, ...data })
          } else {
            setLinkPreview(null)
          }
        })
        .catch((err) => {
          if (err.name !== 'AbortError') setLinkPreview(null)
        })
        .finally(() => setLinkPreviewLoading(false))
      return () => {
        abortController.abort()
      }
    } else if (!url) {
      linkPreviewUrlRef.current = null
      setLinkPreview(null)
    }
  }, [content])

  // Clear draft after successful publish
  const clearDraft = useCallback(() => {
    if (typeof window !== 'undefined' && draftScope) {
      removePostDraft(localStorage, draftScope)
    }
  }, [draftScope])

  // Image upload handler
  const handleImageUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      if (!userId) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }

      if (images.length + files.length > MAX_IMAGES) {
        showToast(t('maxImages'), 'warning')
        return
      }

      const uploadToken = await tokenRefreshCoordinator.getValidToken()
      if (!uploadToken) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }

      setUploading(true)
      setUploadProgress(0)
      const newImages: UploadedImage[] = []
      const totalFiles = Array.from(files).filter(
        (f) => ALLOWED_IMAGE_TYPES.includes(f.type) && f.size <= 5 * 1024 * 1024
      ).length

      let completed = 0
      for (const file of Array.from(files)) {
        if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
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

          // Use XHR for upload progress tracking
          const data = await new Promise<PostImageUploadAcknowledgement>((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/posts/upload-image')
            xhr.setRequestHeader('Authorization', `Bearer ${uploadToken}`)
            const csrfHeaders = getCsrfHeaders()
            Object.entries(csrfHeaders).forEach(([k, v]) => xhr.setRequestHeader(k, v as string))

            const onProgress = (e: ProgressEvent) => {
              if (e.lengthComputable) {
                const fileProgress = e.loaded / e.total
                setUploadProgress(Math.round(((completed + fileProgress) / totalFiles) * 100))
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
              try {
                const responseBody: unknown = JSON.parse(xhr.responseText)
                if (xhr.status >= 200 && xhr.status < 300) {
                  const acknowledgement = readPostImageUploadAcknowledgement(
                    responseBody,
                    userId,
                    process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
                  )
                  if (!acknowledgement) throw new Error('Invalid response')
                  resolve(acknowledgement)
                } else {
                  reject(
                    new Error(
                      readPostMediaUploadError(responseBody) ?? `Upload failed (${xhr.status})`
                    )
                  )
                }
              } catch {
                reject(new Error('Invalid response'))
              }
            }
            const onError = () => {
              cleanup()
              reject(new Error('Network error'))
            }
            const onAbort = () => {
              cleanup()
              reject(new Error('Upload aborted'))
            }

            xhr.upload.addEventListener('progress', onProgress)
            xhr.addEventListener('load', onLoad)
            xhr.addEventListener('error', onError)
            xhr.addEventListener('abort', onAbort)
            xhr.send(formData)
          })

          newImages.push({ url: data.url, fileName: data.fileName })
          completed++
          setUploadProgress(Math.round((completed / totalFiles) * 100))
        } catch (_error) {
          completed++
          showToast(`${file.name}: ${t('networkError')}`, 'error')
        }
      }

      if (newImages.length > 0) {
        setImages((prev) => [...prev, ...newImages])
        showToast(t('uploadSuccess').replace('{count}', String(newImages.length)), 'success')
      }

      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [userId, images.length, showToast, t]
  )

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const insertImageToContent = useCallback(
    (url: string) => {
      setContent((prev) => prev + `\n![image](${url})\n`)
      showToast(t('imageInserted'), 'info')
    },
    [showToast, t]
  )

  // Video upload handler
  const handleVideoUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
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

      if (!ALLOWED_VIDEO_TYPES.includes(file.type)) {
        showToast(t('videoFormatNotSupported'), 'error')
        return
      }

      if (file.size > MAX_VIDEO_SIZE_MB * 1024 * 1024) {
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

        const data = await new Promise<PostVideoUploadAcknowledgement>((resolve, reject) => {
          const xhr = new XMLHttpRequest()

          const onProgress = (event: ProgressEvent) => {
            if (event.lengthComputable) {
              setVideoUploadProgress(Math.round((event.loaded / event.total) * 100))
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
                reject(
                  new Error(
                    readPostMediaUploadError(responseBody) ?? `${t('uploadFailed')} (${xhr.status})`
                  )
                )
              } catch {
                reject(new Error(`${t('uploadFailed')} (${xhr.status})`))
              }
            }
          }

          const onError = () => {
            cleanup()
            reject(new Error(t('networkError')))
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
          Object.entries(getCsrfHeaders()).forEach(([key, value]) => {
            if (value) xhr.setRequestHeader(key, value)
          })
          xhr.send(formData)
        })

        setVideos([{ url: data.url, fileName: data.fileName, fileSize: data.fileSize }])
        setContent((prev) => prev + `\n[video](${data.url})\n`)
        showToast(t('videoUploadSuccess'), 'success')
      } catch (error) {
        logger.error('Video upload error:', error)
        showToast(t('videoUploadFailed'), 'error')
      } finally {
        setVideoUploading(false)
        setVideoUploadProgress(0)
        if (videoInputRef.current) videoInputRef.current.value = ''
      }
    },
    [userId, videos.length, showToast, t]
  )

  const removeVideo = useCallback(() => {
    setVideos([])
    setContent((prev) => removeMarkdownVideoMarkers(prev).content)
    showToast(t('videoRemoved'), 'info')
  }, [showToast, t])

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
      const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/'
      router.push(`/login?returnUrl=${encodeURIComponent(currentPath)}`)
      return
    }

    const capturedViewerScope = getViewerScope()
    if (capturedViewerScope.userId !== userId) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    // Validate poll options BEFORE setting loading state
    const validPollOptions = pollOptions
      .map((option) => option.text.trim())
      .filter((option) => option.length > 0)
    if (pollEnabled) {
      if (validPollOptions.length < 2) {
        showToast(t('pollMinOptions'), 'warning')
        return
      }
    }

    submitRef.current = true
    setLoading(true)
    try {
      const operation = bindPostCreateOperation(
        {
          title,
          content: finalContent,
          group_id: groupId,
          images: images.map((image) => image.url),
          poll_enabled: pollEnabled,
          ...(pollEnabled
            ? {
                poll_options: validPollOptions,
                poll_type: pollType,
                poll_duration_hours: pollDuration,
              }
            : {}),
          visibility: 'group',
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
        showToast(
          result.httpStatus === 403 ? t('permissionDeniedJoinGroup') : result.error,
          'error'
        )
        return
      }
      if (result.status === 'invalid_ack') {
        logger.error('Post creation acknowledgement rejected')
        showToast(t('createPostFailed'), 'error')
        return
      }

      publishOperationRef.current = null
      logger.warn('Post created successfully:', result.data.post.id)

      clearDraft()
      if (typeof window !== 'undefined') {
        localStorage.setItem('last_post_group_id', groupId)
      }
      trackEvent('create_post', { context: 'group', group_id: groupId })
      showToast(t('publishSuccess'), 'success')
      router.push(`/groups/${groupId}`)
    } catch (_error) {
      showToast(t('publishFailed'), 'error')
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
          {t('newPost')}
        </Text>
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
          {groupName ? t('postToGroupName').replace('{name}', groupName) : t('shareIdeas')}
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
                {t('titleLabel')}
              </Text>
              <CharCount current={title.length} max={TITLE_MAX_LENGTH} />
            </Box>
            <input
              type="text"
              placeholder={t('enterTitle')}
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX_LENGTH))}
              maxLength={TITLE_MAX_LENGTH}
              aria-label={t('titleLabel')}
              className="post-editor-input"
              style={{
                ...inputStyle,
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                transition: 'border-color 0.2s, box-shadow 0.2s',
              }}
            />
          </Box>

          {/* Content editor with preview, link preview, sticker picker */}
          <ContentEditor
            content={content}
            setContent={setContent}
            showPreview={showPreview}
            setShowPreview={setShowPreview}
            showStickerPicker={showStickerPicker}
            setShowStickerPicker={setShowStickerPicker}
            draftSaved={draftSaved}
            linkPreview={linkPreview}
            setLinkPreview={setLinkPreview}
            linkPreviewLoading={linkPreviewLoading}
            linkPreviewUrlRef={linkPreviewUrlRef}
            language={language}
            t={t}
          />

          {/* Poll toggle */}
          <ToggleSwitch
            enabled={pollEnabled}
            onToggle={() => setPollEnabled(!pollEnabled)}
            label={t('enablePoll')}
            description={t('pollDescription')}
          />

          {/* Poll settings */}
          {pollEnabled && (
            <PollEditor
              pollOptions={pollOptions}
              setPollOptions={setPollOptions}
              pollType={pollType}
              setPollType={setPollType}
              pollDuration={pollDuration}
              setPollDuration={setPollDuration}
              language={language}
              t={t}
            />
          )}

          {/* Content Warning */}
          <ContentWarningToggle
            isSensitive={isSensitive}
            onToggle={setIsSensitive}
            contentWarning={contentWarning}
            onContentWarningChange={setContentWarning}
          />

          {/* Image upload */}
          <ImageUploader
            images={images}
            uploading={uploading}
            uploadProgress={uploadProgress}
            fileInputRef={fileInputRef}
            onUpload={handleImageUpload}
            onRemove={removeImage}
            onInsert={insertImageToContent}
            language={language}
            t={t}
          />

          {/* Video upload */}
          <VideoUploader
            videos={videos}
            videoUploading={videoUploading}
            videoUploadProgress={videoUploadProgress}
            videoInputRef={videoInputRef}
            onUpload={handleVideoUpload}
            onRemove={removeVideo}
            t={t}
          />

          {/* Action buttons */}
          <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
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
