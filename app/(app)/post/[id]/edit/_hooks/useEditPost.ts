'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'

export interface UploadedImage {
  url: string
  fileName: string
}

export function useEditPost() {
  const params = useParams<{ id: string }>()
  const postId = params.id as string
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [originalPost, setOriginalPost] = useState<Record<string, unknown> | null>(null)
  const [cursorPosition, setCursorPosition] = useState<number | null>(null)
  const [draggedImageIndex, setDraggedImageIndex] = useState<number | null>(null)

  // Fetch user info
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for edit page init */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [])

  // Load post data
  useEffect(() => {
    if (!postId || !userId) return

    const loadPost = async () => {
      setLoading(true)
      try {
        const { data: post, error } = await supabase
          .from('posts')
          .select('id, author_id, title, content, images, image_urls, created_at, updated_at')
          .eq('id', postId)
          .single()

        if (error) {
          logger.error('Error loading post:', error)
          showToast(t('loadPostFailed'), 'error')
          router.push('/my-posts')
          return
        }

        // Verify ownership
        if (post.author_id !== userId) {
          showToast(t('noPermissionEditPost'), 'error')
          router.push('/my-posts')
          return
        }

        setOriginalPost(post)
        setTitle(post.title || '')
        setContent(post.content || '')
        // Support both images and image_urls field names
        const imageUrls = post.images || post.image_urls || []
        setImages(imageUrls.map((url: string) => ({ url, fileName: url.split('/').pop() || '' })))
      } catch (error) {
        logger.error('Error loading post:', error)
        showToast(t('loadPostFailed'), 'error')
      } finally {
        setLoading(false)
      }
    }

    loadPost()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; loadPost defined inside effect
  }, [postId, userId, router, showToast])

  // Handle image upload
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

  // Remove image from list
  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  // Insert image markdown at cursor position
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

  // Move image position in content (up or down)
  const moveImageInContent = (url: string, direction: 'up' | 'down') => {
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

  // Image drag-and-drop reordering
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

  const submitRef = useRef(false)

  // Submit update
  const handleSubmit = async () => {
    if (submitRef.current || saving) return
    submitRef.current = true

    if (!title.trim()) {
      showToast(t('pleaseEnterTitle'), 'warning')
      submitRef.current = false
      return
    }

    if (!userId || !originalPost) {
      showToast(t('cannotSave'), 'error')
      submitRef.current = false
      return
    }

    setSaving(true)
    try {
      // Auto-append un-inserted images to the end of content
      let finalContent = content
      if (images.length > 0) {
        const unincludedImages = images.filter(img => !content.includes(img.url))
        if (unincludedImages.length > 0) {
          finalContent += '\n\n' + unincludedImages.map(img => `![image](${img.url})`).join('\n')
        }
      }

      const { error } = await supabase
        .from('posts')
        .update({
          title,
          content: finalContent,
          images: images.map(img => img.url),
          updated_at: new Date().toISOString(),
        })
        .eq('id', postId)
        .eq('author_id', userId)

      if (error) {
        showToast(error.message, 'error')
        return
      }

      showToast(t('updateSuccess'), 'success')
      router.push('/my-posts')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('updateFailed')
      showToast(errorMessage, 'error')
    } finally {
      setSaving(false)
      submitRef.current = false
    }
  }

  return {
    // State
    email,
    title,
    setTitle,
    content,
    setContent,
    loading,
    saving,
    images,
    uploading,
    showPreview,
    setShowPreview,
    originalPost,
    draggedImageIndex,

    // Refs
    fileInputRef,
    textareaRef,

    // Handlers
    handleImageUpload,
    removeImage,
    insertImageToContent,
    moveImageInContent,
    removeImageFromContent,
    isImageInContent,
    handleTextareaSelect,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleSubmit,

    // i18n
    t,

    // Navigation
    router,
  }
}
