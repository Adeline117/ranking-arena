'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import { checkAndUnlock } from '@/lib/services/achievements'
import type { UploadedImage, UploadedVideo, PollOption } from './types'
import {
  DRAFT_KEY_PREFIX,
  POLL_DURATION_OPTIONS_ZH,
  POLL_DURATION_OPTIONS_EN,
} from './types'

export function usePostForm() {
  const params = useParams<{ handle: string }>()
  const handle = params.handle as string
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const POLL_DURATION_OPTIONS = language === 'zh' ? POLL_DURATION_OPTIONS_ZH : POLL_DURATION_OPTIONS_EN
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const submitRef = useRef(false)
  const [cursorPosition, setCursorPosition] = useState<number | null>(null)

  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showStickerPicker, setShowStickerPicker] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [pollEnabled, setPollEnabled] = useState(false)
  const [pollOptions, setPollOptions] = useState<PollOption[]>([
    { text: '', votes: 0 },
    { text: '', votes: 0 },
  ])
  const [pollDuration, setPollDuration] = useState(0)
  const [pollType, setPollType] = useState<'single' | 'multiple'>('single')
  const [draggedImageIndex, setDraggedImageIndex] = useState<number | null>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const [videos, setVideos] = useState<UploadedVideo[]>([])
  const [videoUploading, setVideoUploading] = useState(false)
  const [videoUploadProgress, setVideoUploadProgress] = useState(0)

  const draftKey = `${DRAFT_KEY_PREFIX}${handle}`

  useEffect(() => {

    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    })
  }, [])

  // Load draft from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined' && handle) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore draft once on mount; showToast/t are stable refs
  }, [handle, draftKey])

  // Auto-save draft to localStorage (debounced)
  useEffect(() => {
    if (typeof window === 'undefined' || !handle) return

    const saveTimer = setTimeout(() => {
      if (title.trim() || content.trim()) {
        localStorage.setItem(draftKey, JSON.stringify({ title, content, images, pollEnabled }))
        setDraftSaved(true)
        setTimeout(() => setDraftSaved(false), 2000)
      }
    }, 1000)

    return () => clearTimeout(saveTimer)
  }, [title, content, images, pollEnabled, handle, draftKey])

  // Clear draft after successful publish
  const clearDraft = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey])

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
        const formData = new FormData()
        formData.append('file', file)
        formData.append('userId', userId)

        const response = await fetch('/api/posts/upload-image', {
          method: 'POST',
          headers: {
            ...getCsrfHeaders()
          },
          body: formData,
        })

        const data = await response.json()

        if (!response.ok) {
          showToast(data.error || t('uploadFailed'), 'error')
          continue
        }

        newImages.push({
          url: data.url,
          fileName: data.fileName,
        })
      } catch (error) {
        logger.error('Upload error:', error)
        showToast(t('uploadFailed'), 'error')
      }
    }

    if (newImages.length > 0) {
      setImages(prev => [...prev, ...newImages])
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

    const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']
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
      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', userId)

      const xhr = new XMLHttpRequest()

      const uploadPromise = new Promise<{ url: string; fileName: string; fileSize: number }>((resolve, reject) => {
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100)
            setVideoUploadProgress(progress)
          }
        })

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const data = JSON.parse(xhr.responseText)
              resolve(data)
            } catch {
              reject(new Error(t('parseResponseFailed')))
            }
          } else {
            try {
              const error = JSON.parse(xhr.responseText)
              reject(new Error(error.error || t('uploadFailed')))
            } catch {
              reject(new Error(`${t('uploadFailed')} (${xhr.status})`))
            }
          }
        })

        xhr.addEventListener('error', () => {
          reject(new Error(t('networkErrorRetry')))
        })

        xhr.open('POST', '/api/posts/upload-video')

        const csrfHeaders = getCsrfHeaders()
        Object.entries(csrfHeaders).forEach(([key, value]) => {
          if (value) xhr.setRequestHeader(key, value)
        })

        xhr.send(formData)
      })

      const data = await uploadPromise

      setVideos([{
        url: data.url,
        fileName: data.fileName,
        fileSize: data.fileSize,
      }])

      const videoMarkdown = `\n[${t('video')}](${data.url})\n`
      setContent(prev => prev + videoMarkdown)

      showToast(t('videoUploadSuccess'), 'success')
    } catch (error) {
      logger.error('Video upload error:', error)
      showToast(error instanceof Error ? error.message : t('videoUploadFailed'), 'error')
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
    setContent(prev => {
      return prev.replace(/\n?\[(?:视频|Video)\]\([^)]+\)\n?/g, '')
    })
    showToast(t('videoRemoved'), 'info')
  }

  // Remove image
  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  // Image drag reorder
  const handleDragStart = (index: number) => {
    setDraggedImageIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedImageIndex === null || draggedImageIndex === index) return

    setImages(prev => {
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
      setContent(prev => {
        const before = prev.slice(0, cursorPosition)
        const after = prev.slice(cursorPosition)
        return before + imageMarkdown + after
      })
      setCursorPosition(cursorPosition + imageMarkdown.length)
    } else {
      setContent(prev => prev + imageMarkdown)
    }
    showToast(t('imageInserted'), 'info')
  }

  // Move image position in content
  const moveImageInContent = (url: string, direction: 'up' | 'down') => {
    const _imagePattern = `![image](${url})`
    const regex = /!\[image\]\([^)]+\)/g
    const matches: { match: string; start: number; end: number }[] = []
    let m
    while ((m = regex.exec(content)) !== null) {
      matches.push({ match: m[0], start: m.index, end: m.index + m[0].length })
    }

    const currentIndex = matches.findIndex(m => m.match.includes(url))
    if (currentIndex === -1) return

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
    if (targetIndex < 0 || targetIndex >= matches.length) {
      showToast(direction === 'up' ? t('alreadyAtTop') : t('alreadyAtBottom'), 'info')
      return
    }

    const current = matches[currentIndex]
    const target = matches[targetIndex]

    let newContent = content
    const placeholder1 = `__PLACEHOLDER_1__`
    const placeholder2 = `__PLACEHOLDER_2__`

    if (direction === 'up') {
      newContent = newContent.slice(0, target.start) + placeholder1 +
                   newContent.slice(target.end, current.start) + placeholder2 +
                   newContent.slice(current.end)
      newContent = newContent.replace(placeholder1, current.match)
      newContent = newContent.replace(placeholder2, target.match)
    } else {
      newContent = newContent.slice(0, current.start) + placeholder1 +
                   newContent.slice(current.end, target.start) + placeholder2 +
                   newContent.slice(target.end)
      newContent = newContent.replace(placeholder1, target.match)
      newContent = newContent.replace(placeholder2, current.match)
    }

    setContent(newContent)
    showToast(direction === 'up' ? t('imageMovedUp') : t('imageMovedDown'), 'success')
  }

  // Remove image from content
  const removeImageFromContent = (url: string) => {
    const imagePattern = new RegExp(`\\n?!\\[image\\]\\(${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\n?`, 'g')
    setContent(prev => prev.replace(imagePattern, '\n').replace(/\n{3,}/g, '\n\n').trim())
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
    }
  }

  const handleSubmit = async () => {
    if (submitRef.current || loading) return
    submitRef.current = true

    if (!title.trim()) {
      showToast(t('pleaseEnterTitle'), 'warning')
      submitRef.current = false
      return
    }

    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      const currentPath = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/login'
      router.push(`/login?returnUrl=${encodeURIComponent(currentPath)}`)
      submitRef.current = false
      return
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', userId)
      .maybeSingle()

    const decodedHandle = decodeURIComponent(handle)
    if (!profile || profile.handle !== decodedHandle) {
      showToast(t('noPermission'), 'error')
      submitRef.current = false
      return
    }

    setLoading(true)
    try {
      let finalContent = content
      if (images.length > 0) {
        const unincludedImages = images.filter(img => !content.includes(img.url))
        if (unincludedImages.length > 0) {
          finalContent += '\n\n' + unincludedImages.map(img => `![image](${img.url})`).join('\n')
        }
      }

      let validPollOptions: { text: string; votes: number }[] = []
      if (pollEnabled) {
        validPollOptions = pollOptions.filter(opt => opt.text.trim())
        if (validPollOptions.length < 2) {
          showToast(t('pollMinOptions'), 'warning')
          setLoading(false)
          submitRef.current = false
          return
        }
      }

      const { data: newPost, error: postError } = await supabase
        .from('posts')
        .insert({
          title,
          content: finalContent,
          author_handle: decodedHandle,
          author_id: userId,
          images: images.map(img => img.url),
          poll_enabled: pollEnabled,
        })
        .select('id')
        .single()

      if (postError || !newPost) {
        logger.error('Post creation failed:', JSON.stringify(postError, null, 2))
        showToast(postError?.message || t('createPostFailed'), 'error')
        return
      }

      if (pollEnabled && validPollOptions.length >= 2) {
        const endAt = pollDuration > 0
          ? new Date(Date.now() + pollDuration * 60 * 60 * 1000).toISOString()
          : null

        const { data: pollData, error: pollError } = await supabase
          .from('polls')
          .insert({
            post_id: newPost.id,
            question: title,
            options: validPollOptions.map((opt, index) => ({
              text: opt.text.trim(),
              votes: 0,
              index
            })),
            type: pollType,
            end_at: endAt,
          })
          .select('id')
          .single()

        if (pollError) {
          logger.error('Poll creation failed:', JSON.stringify(pollError, null, 2))
          await supabase.from('posts').delete().eq('id', newPost.id)
          showToast(`${t('pollCreateFailed')}: ${pollError.message || pollError.code || t('unknownError')}`, 'error')
          return
        } else if (pollData) {
          await supabase
            .from('posts')
            .update({ poll_id: pollData.id })
            .eq('id', newPost.id)
        }
      }

      clearDraft()
      showToast(t('publishSuccess'), 'success')
      // Achievement: first post
      if (userId) {
        checkAndUnlock(userId, 'first_post')
      }
      router.push(`/u/${encodeURIComponent(decodedHandle)}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('publishFailed')
      showToast(errorMessage, 'error')
    } finally {
      setLoading(false)
      submitRef.current = false
    }
  }

  return {
    // Refs
    fileInputRef,
    textareaRef,
    videoInputRef,
    // Auth
    email,
    // Form state
    title,
    setTitle,
    content,
    setContent,
    loading,
    images,
    uploading,
    showPreview,
    setShowPreview,
    showStickerPicker,
    setShowStickerPicker,
    draftSaved,
    // Poll state
    pollEnabled,
    setPollEnabled,
    pollOptions,
    setPollOptions,
    pollType,
    setPollType,
    pollDuration,
    setPollDuration,
    POLL_DURATION_OPTIONS,
    // Image state
    draggedImageIndex,
    // Video state
    videos,
    videoUploading,
    videoUploadProgress,
    // Handlers
    handleImageUpload,
    handleVideoUpload,
    removeVideo,
    removeImage,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    insertImageToContent,
    moveImageInContent,
    removeImageFromContent,
    isImageInContent,
    handleTextareaSelect,
    handleSubmit,
    // i18n
    t,
    language,
    // Navigation
    router,
  }
}
