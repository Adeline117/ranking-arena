'use client'

import { features } from '@/lib/features'
import { notFound } from 'next/navigation'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import { compressImage } from '@/lib/utils/image-compress'
import { logger } from '@/lib/logger'
import { ContentWarningToggle } from '@/app/components/post/components/ContentWarningToggle'
import type { UploadedImage, UploadedVideo, PollOption, LinkPreview } from './types'
import {
  TITLE_MAX_LENGTH, DRAFT_KEY_PREFIX,
  MAX_IMAGES, MAX_VIDEO_SIZE_MB,
  ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES,
} from './types'
import { CharCount, ToggleSwitch, inputStyle } from './components/FormControls'
import { ContentEditor } from './components/ContentEditor'
import { PollEditor } from './components/PollEditor'
import { ImageUploader } from './components/ImageUploader'
import { VideoUploader } from './components/VideoUploader'

export default function NewGroupPostPage(): React.ReactElement {
  if (!features.social) notFound()

  const params = useParams<{ id: string }>()
  const groupId = params.id as string
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const submitRef = useRef(false)

  // User state
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [userHandle, setUserHandle] = useState<string | null>(null)

  // Form state
  const [groupName, setGroupName] = useState<string>('')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showStickerPicker, setShowStickerPicker] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)

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

  const draftKey = `${DRAFT_KEY_PREFIX}${groupId}`

  useEffect(() => {
    if (!groupId) return

    supabase.auth.getUser().then(async ({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)

      if (!data.user) {
        const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/'
        router.push(`/login?returnUrl=${encodeURIComponent(currentPath)}`)
        return
      }

      loadUserHandle(data.user.id)

      // Check membership and mute status
      const { data: membership, error: membershipError } = await supabase
        .from('group_members')
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase/t/loadUserHandle are stable; auth check runs on mount
  }, [router, groupId, showToast, language])

  // Load group name
  useEffect(() => {
    if (!groupId) return

    const loadGroupName = async () => {
      const { data } = await supabase
        .from('groups')
        .select('name')
        .eq('id', groupId)
        .maybeSingle()

      if (data?.name) {
        setGroupName(data.name)
      }
    }

    loadGroupName()
  }, [groupId])

  const loadUserHandle = async (uid: string) => {
    try {
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', uid)
        .maybeSingle()

      if (userProfile?.handle) {
        setUserHandle(userProfile.handle)
        return
      }

      const { data: user } = await supabase.auth.getUser()
      if (user?.user?.email) {
        setUserHandle(user.user.email.split('@')[0])
      }
    } catch (error) {
      logger.error('Error loading user handle:', error)
    }
  }

  // Load draft from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined' && groupId) {
      const draft = localStorage.getItem(draftKey)
      if (draft) {
        try {
          const { title: draftTitle, content: draftContent, images: draftImages, pollEnabled: draftPollEnabled } = JSON.parse(draft)
          if (draftTitle || draftContent) {
            setTitle(draftTitle || '')
            setContent(draftContent || '')
            setImages(draftImages || [])
            setPollEnabled(draftPollEnabled || false)
            showToast(t('draftRestored'), 'info')
          }
        } catch (e) {
          logger.error('Failed to parse draft:', e)
        }
      }
    }
  }, [groupId, draftKey, showToast, t])

  // Auto-save draft to localStorage (debounced)
  useEffect(() => {
    if (typeof window === 'undefined' || !groupId) return

    let draftResetTimer: ReturnType<typeof setTimeout> | null = null

    const saveTimer = setTimeout(() => {
      if (title.trim() || content.trim()) {
        localStorage.setItem(draftKey, JSON.stringify({ title, content, images, pollEnabled }))
        setDraftSaved(true)
        draftResetTimer = setTimeout(() => setDraftSaved(false), 2000)
      }
    }, 1000)

    return () => {
      clearTimeout(saveTimer)
      if (draftResetTimer !== null) clearTimeout(draftResetTimer)
    }
  }, [title, content, images, pollEnabled, groupId, draftKey])

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
        .then(r => r.ok ? r.json() : null)
        .then(data => {
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
      return () => { abortController.abort() }
    } else if (!url) {
      linkPreviewUrlRef.current = null
      setLinkPreview(null)
    }
  }, [content])

  // Clear draft after successful publish
  const clearDraft = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey])

  // Image upload handler
  const handleImageUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
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

    setUploading(true)
    setUploadProgress(0)
    const newImages: UploadedImage[] = []
    const totalFiles = Array.from(files).filter(f => ALLOWED_IMAGE_TYPES.includes(f.type) && f.size <= 5 * 1024 * 1024).length

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
        formData.append('userId', userId)

        // Use XHR for upload progress tracking
        const data = await new Promise<{ url: string; fileName: string }>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', '/api/posts/upload-image')
          const csrfHeaders = getCsrfHeaders()
          Object.entries(csrfHeaders).forEach(([k, v]) => xhr.setRequestHeader(k, v as string))

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const fileProgress = e.loaded / e.total
              setUploadProgress(Math.round(((completed + fileProgress) / totalFiles) * 100))
            }
          }
          xhr.onload = () => {
            try {
              const result = JSON.parse(xhr.responseText)
              if (xhr.status >= 200 && xhr.status < 300) resolve(result)
              else reject(new Error(result.error || `Upload failed (${xhr.status})`))
            } catch { reject(new Error('Invalid response')) }
          }
          xhr.onerror = () => reject(new Error('Network error'))
          xhr.send(formData)
        })

        newImages.push({ url: data.url, fileName: data.fileName })
        completed++
        setUploadProgress(Math.round((completed / totalFiles) * 100))
      } catch (error) {
        completed++
        const errorMsg = error instanceof Error ? error.message : t('networkError')
        showToast(`${file.name}: ${errorMsg}`, 'error')
      }
    }

    if (newImages.length > 0) {
      setImages(prev => [...prev, ...newImages])
      showToast(t('uploadSuccess').replace('{count}', String(newImages.length)), 'success')
    }

    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [userId, images.length, showToast, t])

  const removeImage = useCallback((index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  const insertImageToContent = useCallback((url: string) => {
    setContent(prev => prev + `\n![image](${url})\n`)
    showToast(t('imageInserted'), 'info')
  }, [showToast, t])

  // Video upload handler
  const handleVideoUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
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
      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', userId)

      const data = await new Promise<{ url: string; fileName: string; fileSize: number }>((resolve, reject) => {
        const xhr = new XMLHttpRequest()

        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            setVideoUploadProgress(Math.round((event.loaded / event.total) * 100))
          }
        })

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText))
            } catch {
              reject(new Error(t('parseResponseFailed')))
            }
          } else {
            const error = JSON.parse(xhr.responseText).error || `${t('uploadFailed')} (${xhr.status})`
            reject(new Error(error))
          }
        })

        xhr.addEventListener('error', () => reject(new Error(t('networkError'))))

        xhr.open('POST', '/api/posts/upload-video')
        Object.entries(getCsrfHeaders()).forEach(([key, value]) => {
          if (value) xhr.setRequestHeader(key, value)
        })
        xhr.send(formData)
      })

      setVideos([{ url: data.url, fileName: data.fileName, fileSize: data.fileSize }])
      setContent(prev => prev + `\n[video](${data.url})\n`)
      showToast(t('videoUploadSuccess'), 'success')
    } catch (error) {
      logger.error('Video upload error:', error)
      showToast(error instanceof Error ? error.message : t('videoUploadFailed'), 'error')
    } finally {
      setVideoUploading(false)
      setVideoUploadProgress(0)
      if (videoInputRef.current) videoInputRef.current.value = ''
    }
  }, [userId, videos.length, showToast, t])

  const removeVideo = useCallback(() => {
    setVideos([])
    setContent(prev => prev.replace(/\n?\[(?:视频|video)\]\([^)]+\)\n?/g, ''))
    showToast(t('videoRemoved'), 'info')
  }, [showToast, t])

  const handleSubmit = async () => {
    if (submitRef.current || loading) return

    if (!title.trim()) {
      showToast(t('pleaseEnterTitle'), 'warning')
      return
    }

    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/'
      router.push(`/login?returnUrl=${encodeURIComponent(currentPath)}`)
      return
    }

    // Validate poll options BEFORE setting loading state
    if (pollEnabled) {
      const validOptions = pollOptions.filter(opt => opt.text.trim())
      if (validOptions.length < 2) {
        showToast(t('pollMinOptions'), 'warning')
        return
      }
    }

    submitRef.current = true
    setLoading(true)
    try {
      let finalContent = content
      if (images.length > 0) {
        const unincludedImages = images.filter(img => !content.includes(img.url))
        if (unincludedImages.length > 0) {
          finalContent += '\n\n' + unincludedImages.map(img => `![image](${img.url})`).join('\n')
        }
      }

      let pollId = null
      if (pollEnabled) {
        const validOptions = pollOptions.filter(opt => opt.text.trim())
        const endAt = new Date(Date.now() + pollDuration * 60 * 60 * 1000)

        const { data: pollData, error: pollError } = await supabase
          .from('polls')
          .insert({
            question: title,
            options: validOptions.map((opt, index) => ({
              text: opt.text.trim(),
              votes: 0,
              index
            })),
            type: pollType,
            end_at: endAt.toISOString(),
          })
          .select('id')
          .single()

        if (pollError) {
          const errorMsg = pollError.message || t('createPollFailed')
          showToast(errorMsg, 'error')
          setLoading(false)
          submitRef.current = false
          return
        }
        pollId = pollData.id
      }

      const { data: postData, error } = await supabase.from('posts').insert({
        title,
        content: finalContent,
        author_handle: userHandle || email?.split('@')[0] || 'user',
        group_id: groupId,
        author_id: userId,
        images: images.map(img => img.url),
        poll_enabled: pollEnabled,
        poll_id: pollId,
        visibility: 'group',
        is_sensitive: isSensitive,
        content_warning: isSensitive && contentWarning ? contentWarning : null,
      }).select('id').single()

      if (error) {
        logger.error('Post creation error:', error)
        const errorMsg = error.code === '42501'
          ? t('permissionDeniedJoinGroup')
          : (error.message || t('createPostFailed'))
        showToast(errorMsg, 'error')
        setLoading(false)
        submitRef.current = false
        return
      }

      logger.warn('Post created successfully:', postData?.id)

      clearDraft()
      if (typeof window !== 'undefined') {
        localStorage.setItem('last_post_group_id', groupId)
      }
      showToast(t('publishSuccess'), 'success')
      router.push(`/groups/${groupId}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('publishFailed')
      showToast(errorMessage, 'error')
    } finally {
      setLoading(false)
      submitRef.current = false
    }
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
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
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
              <Text size="sm" weight="bold">{t('titleLabel')}</Text>
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
              style={{ ...inputStyle, padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`, transition: 'border-color 0.2s, box-shadow 0.2s' }}
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
            <Button
              variant="ghost"
              size="md"
              onClick={() => router.back()}
              disabled={loading}
            >
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
