'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import { DynamicStickerPicker } from '@/app/components/ui/Dynamic'
import type { Sticker } from '@/lib/stickers'

interface UploadedImage {
  url: string
  fileName: string
}

interface UploadedVideo {
  url: string
  fileName: string
  fileSize: number
}

interface PollOption {
  text: string
  votes: number
}

const TITLE_MAX_LENGTH = 100
const CONTENT_MAX_LENGTH = 10000
const DRAFT_KEY_PREFIX = 'post_draft_'

// 投票持续时间选项
const POLL_DURATION_OPTIONS_ZH = [
  { label: '1小时', value: 1 },
  { label: '6小时', value: 6 },
  { label: '12小时', value: 12 },
  { label: '1天', value: 24 },
  { label: '3天', value: 72 },
  { label: '7天', value: 168 },
]

const POLL_DURATION_OPTIONS_EN = [
  { label: '1 hour', value: 1 },
  { label: '6 hours', value: 6 },
  { label: '12 hours', value: 12 },
  { label: '1 day', value: 24 },
  { label: '3 days', value: 72 },
  { label: '7 days', value: 168 },
]

// 解析视频链接
function parseVideoUrl(url: string): { type: 'youtube' | 'bilibili'; embedUrl: string } | null {
  // YouTube
  const youtubeMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/)
  if (youtubeMatch) {
    return { type: 'youtube', embedUrl: `https://www.youtube.com/embed/${youtubeMatch[1]}` }
  }
  // Bilibili
  const bilibiliMatch = url.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)|bilibili\.com\/video\/av(\d+)/)
  if (bilibiliMatch) {
    const bvid = bilibiliMatch[1]
    const aid = bilibiliMatch[2]
    if (bvid) return { type: 'bilibili', embedUrl: `//player.bilibili.com/player.html?bvid=${bvid}&autoplay=0` }
    if (aid) return { type: 'bilibili', embedUrl: `//player.bilibili.com/player.html?aid=${aid}&autoplay=0` }
  }
  return null
}

// 视频播放器组件
function VideoPlayer({ embedUrl, type }: { embedUrl: string; type: string }) {
  return (
    <div style={{ position: 'relative', width: '100%', paddingBottom: '56.25%', margin: '8px 0', borderRadius: 8, overflow: 'hidden', background: '#000' }}>
      <iframe
        src={embedUrl}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
        allowFullScreen
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        title={type === 'youtube' ? 'YouTube video' : 'Bilibili video'}
      />
    </div>
  )
}

// 链接解析函数（支持视频嵌入）
// 带编辑控制的内容渲染（用于预览模式）
function renderContentWithControls(
  text: string,
  onMoveImage: (url: string, direction: 'up' | 'down') => void,
  onRemoveImage: (url: string) => void,
  imageCount: number,
  t: (key: string) => string
) {
  if (!text) return null
  
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  
  // 先找出所有图片
  const imageMatches: { start: number; end: number; alt: string; url: string; imageIndex: number }[] = []
  let match
  let imgIdx = 0
  while ((match = imageRegex.exec(text)) !== null) {
    imageMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      alt: match[1],
      url: match[2],
      imageIndex: imgIdx++,
    })
  }
  
  // 如果没有图片，直接处理链接
  if (imageMatches.length === 0) {
    const linkParts = text.split(urlRegex)
    return linkParts.map((part, index) => {
      if (urlRegex.test(part)) {
        urlRegex.lastIndex = 0
        const video = parseVideoUrl(part)
        if (video) {
          return <VideoPlayer key={index} embedUrl={video.embedUrl} type={video.type} />
        }
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              color: '#8b6fa8',
              textDecoration: 'underline',
              wordBreak: 'break-all',
            }}
          >
            {part}
          </a>
        )
      }
      return part
    })
  }
  
  // 构建内容片段
  const parts: { type: 'text' | 'image' | 'link' | 'video'; content: string; url?: string; video?: { embedUrl: string; type: string }; imageIndex?: number }[] = []
  let currentIndex = 0
  
  for (const img of imageMatches) {
    if (img.start > currentIndex) {
      const beforeText = text.slice(currentIndex, img.start)
      const linkParts = beforeText.split(urlRegex)
      linkParts.forEach((part) => {
        if (urlRegex.test(part)) {
          urlRegex.lastIndex = 0
          const video = parseVideoUrl(part)
          if (video) {
            parts.push({ type: 'video', content: part, video })
          } else {
            parts.push({ type: 'link', content: part, url: part })
          }
        } else if (part) {
          parts.push({ type: 'text', content: part })
        }
      })
    }
    parts.push({ type: 'image', content: img.alt, url: img.url, imageIndex: img.imageIndex })
    currentIndex = img.end
  }
  
  if (currentIndex < text.length) {
    const afterText = text.slice(currentIndex)
    const linkParts = afterText.split(urlRegex)
    linkParts.forEach((part) => {
      if (urlRegex.test(part)) {
        urlRegex.lastIndex = 0
        const video = parseVideoUrl(part)
        if (video) {
          parts.push({ type: 'video', content: part, video })
        } else {
          parts.push({ type: 'link', content: part, url: part })
        }
      } else if (part) {
        parts.push({ type: 'text', content: part })
      }
    })
  }
  
  return parts.map((part, index) => {
    if (part.type === 'image') {
      const isFirst = part.imageIndex === 0
      const isLast = part.imageIndex === imageCount - 1
      return (
        <span key={index} style={{ position: 'relative', display: 'inline-block', margin: '4px 6px' }}>
          <Image
            src={part.url || ''}
            alt={part.content || 'image'}
            width={400}
            height={300}
            style={{
              maxWidth: '100%',
              maxHeight: 300,
              borderRadius: 8,
              cursor: 'pointer',
              display: 'block',
              objectFit: 'contain',
            }}
            onClick={(e) => {
              e.stopPropagation()
              window.open(part.url, '_blank')
            }}
            unoptimized
          />
          {/* 图片控制栏 */}
          <div style={{
            position: 'absolute',
            top: 4,
            right: 4,
            display: 'flex',
            gap: 4,
            background: 'rgba(0,0,0,0.7)',
            borderRadius: 6,
            padding: '2px 4px',
          }}>
            <button
              onClick={(e) => { e.stopPropagation(); onMoveImage(part.url!, 'up') }}
              disabled={isFirst}
              title={t('moveUp')}
              style={{
                width: 24,
                height: 24,
                border: 'none',
                background: isFirst ? 'rgba(100,100,100,0.5)' : 'rgba(139,111,168,0.9)',
                color: '#fff',
                cursor: isFirst ? 'not-allowed' : 'pointer',
                fontSize: 14,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ↑
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onMoveImage(part.url!, 'down') }}
              disabled={isLast}
              title={t('moveDown')}
              style={{
                width: 24,
                height: 24,
                border: 'none',
                background: isLast ? 'rgba(100,100,100,0.5)' : 'rgba(139,111,168,0.9)',
                color: '#fff',
                cursor: isLast ? 'not-allowed' : 'pointer',
                fontSize: 14,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ↓
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onRemoveImage(part.url!) }}
              title={t('remove')}
              style={{
                width: 24,
                height: 24,
                border: 'none',
                background: 'rgba(255,77,77,0.9)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: 14,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ×
            </button>
          </div>
        </span>
      )
    }
    if (part.type === 'video' && part.video) {
      return <VideoPlayer key={index} embedUrl={part.video.embedUrl} type={part.video.type} />
    }
    if (part.type === 'link') {
      return (
        <a
          key={index}
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: '#8b6fa8',
            textDecoration: 'underline',
            wordBreak: 'break-all',
          }}
        >
          {part.content}
        </a>
      )
    }
    return <span key={index}>{part.content}</span>
  })
}

export default function NewPostPage() {
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
  // 投票相关状态
  const [pollEnabled, setPollEnabled] = useState(false)
  const [pollOptions, setPollOptions] = useState<PollOption[]>([
    { text: '', votes: 0 },
    { text: '', votes: 0 },
  ])
  const [pollDuration, setPollDuration] = useState(0) // 默认永久（0表示永久）
  const [pollType, setPollType] = useState<'single' | 'multiple'>('single')
  // 图片拖拽排序状态
  const [draggedImageIndex, setDraggedImageIndex] = useState<number | null>(null)
  // 视频相关状态
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
          console.error('Failed to parse draft:', e)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, draftKey])

  // Auto-save draft to localStorage (debounced)
  useEffect(() => {
    if (typeof window === 'undefined' || !handle) return
    
    const saveTimer = setTimeout(() => {
      if (title.trim() || content.trim()) {
        localStorage.setItem(draftKey, JSON.stringify({ title, content, images, pollEnabled }))
        setDraftSaved(true)
        // Reset saved indicator after 2 seconds
        setTimeout(() => setDraftSaved(false), 2000)
      }
    }, 1000) // Save 1 second after user stops typing

    return () => clearTimeout(saveTimer)
  }, [title, content, images, pollEnabled, handle, draftKey])

  // Clear draft after successful publish
  const clearDraft = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey])

  // 处理图片上传
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
      // 验证文件类型
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
      if (!allowedTypes.includes(file.type)) {
        showToast(`${file.name} ${t('formatNotSupported')}`, 'error')
        continue
      }

      // 验证文件大小 (5MB)
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
        console.error('Upload error:', error)
        showToast(t('uploadFailed'), 'error')
      }
    }

    if (newImages.length > 0) {
      setImages(prev => [...prev, ...newImages])
      showToast(t('uploadSuccess').replace('{count}', String(newImages.length)), 'success')
    }

    setUploading(false)
    // 清空 file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // 处理视频上传
  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    // 最多上传1个视频
    if (videos.length >= 1) {
      showToast(t('maxOneVideo'), 'warning')
      return
    }

    const file = files[0]

    // 验证文件类型
    const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']
    if (!allowedTypes.includes(file.type)) {
      showToast(t('unsupportedVideoFormat'), 'error')
      return
    }

    // 验证文件大小 (100MB)
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

      // 使用 XMLHttpRequest 以支持进度监控
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

        // 添加 CSRF headers
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

      // 自动插入视频链接到内容
      const videoMarkdown = `\n[${t('video')}](${data.url})\n`
      setContent(prev => prev + videoMarkdown)

      showToast(t('videoUploadSuccess'), 'success')
    } catch (error) {
      console.error('Video upload error:', error)
      showToast(error instanceof Error ? error.message : t('videoUploadFailed'), 'error')
    } finally {
      setVideoUploading(false)
      setVideoUploadProgress(0)
      if (videoInputRef.current) {
        videoInputRef.current.value = ''
      }
    }
  }

  // 移除视频
  const removeVideo = () => {
    setVideos([])
    // 从内容中移除视频链接
    setContent(prev => {
      // Remove video links in both languages: [视频](url) or [Video](url)
      return prev.replace(/\n?\[(?:视频|Video)\]\([^)]+\)\n?/g, '')
    })
    showToast(t('videoRemoved'), 'info')
  }

  // 移除图片
  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  // 图片拖拽排序处理
  const handleDragStart = (index: number) => {
    setDraggedImageIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedImageIndex === null || draggedImageIndex === index) return
    
    // 重新排序图片
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

  // 插入图片到内容（在光标位置）
  const insertImageToContent = (url: string) => {
    const imageMarkdown = `\n![image](${url})\n`
    
    // 如果有记录的光标位置，在光标位置插入
    if (cursorPosition !== null) {
      setContent(prev => {
        const before = prev.slice(0, cursorPosition)
        const after = prev.slice(cursorPosition)
        return before + imageMarkdown + after
      })
      // 更新光标位置
      setCursorPosition(cursorPosition + imageMarkdown.length)
    } else {
      // 否则添加到末尾
      setContent(prev => prev + imageMarkdown)
    }
    showToast(t('imageInserted'), 'info')
  }

  // 移动图片在内容中的位置（上移或下移）
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

    // 交换两个图片的位置
    const current = matches[currentIndex]
    const target = matches[targetIndex]

    let newContent = content
    // 用占位符替换，避免重叠问题
    const placeholder1 = `__PLACEHOLDER_1__`
    const placeholder2 = `__PLACEHOLDER_2__`

    if (direction === 'up') {
      // 先替换后面的，再替换前面的
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

  // 从内容中移除图片
  const removeImageFromContent = (url: string) => {
    const imagePattern = new RegExp(`\\n?!\\[image\\]\\(${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\n?`, 'g')
    setContent(prev => prev.replace(imagePattern, '\n').replace(/\n{3,}/g, '\n\n').trim())
    showToast(t('imageRemovedFromContent'), 'info')
  }

  // 检查图片是否已在内容中
  const isImageInContent = (url: string) => {
    return content.includes(url)
  }

  // 保存光标位置
  const handleTextareaSelect = () => {
    if (textareaRef.current) {
      setCursorPosition(textareaRef.current.selectionStart)
    }
  }

  const handleSubmit = async () => {
    // Prevent double submission
    if (submitRef.current || loading) return
    submitRef.current = true

    if (!title.trim()) {
      showToast(t('pleaseEnterTitle'), 'warning')
      submitRef.current = false
      return
    }

    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      router.push('/login')
      submitRef.current = false
      return
    }

    // 获取用户的handle
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', userId)
      .maybeSingle()

    // 解码 URL 中的 handle 进行比较（中文用户名会被编码）
    const decodedHandle = decodeURIComponent(handle)
    if (!profile || profile.handle !== decodedHandle) {
      showToast(t('noPermission'), 'error')
      submitRef.current = false
      return
    }

    setLoading(true)
    try {
      // 如果有图片但没有插入到内容中，自动附加到内容末尾
      let finalContent = content
      if (images.length > 0) {
        const unincludedImages = images.filter(img => !content.includes(img.url))
        if (unincludedImages.length > 0) {
          finalContent += '\n\n' + unincludedImages.map(img => `![image](${img.url})`).join('\n')
        }
      }

      // 验证投票选项（如果开启投票）
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

      // 1. 先创建帖子
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
        console.error('创建帖子失败:', JSON.stringify(postError, null, 2))
        showToast(postError?.message || t('createPostFailed'), 'error')
        return
      }

      // 2. 如果开启投票，创建投票并更新帖子
      if (pollEnabled && validPollOptions.length >= 2) {
        // 计算截止时间（0表示永久，不设置截止时间）
        const endAt = pollDuration > 0 
          ? new Date(Date.now() + pollDuration * 60 * 60 * 1000).toISOString()
          : null

        // 创建投票（带上 post_id）
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
          console.error('创建投票失败:', JSON.stringify(pollError, null, 2))
          console.error('投票数据:', { post_id: newPost.id, question: title, type: pollType })
          // Poll creation failed - delete the post to maintain consistency
          await supabase.from('posts').delete().eq('id', newPost.id)
          showToast(`${t('pollCreateFailed')}: ${pollError.message || pollError.code || t('unknownError')}`, 'error')
          return // Don't redirect - let user fix and retry
        } else if (pollData) {
          // 更新帖子的 poll_id
          await supabase
            .from('posts')
            .update({ poll_id: pollData.id })
            .eq('id', newPost.id)
        }
      }

      // Clear draft after successful publish
      clearDraft()
      showToast(t('publishSuccess'), 'success')
      router.push(`/u/${encodeURIComponent(decodedHandle)}`)
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
          {t('postUpdate')}
        </Text>
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
          {t('shareIdeas')}
        </Text>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          <Box>
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
              <Text size="sm" weight="bold">
                {t('titleLabel')}
              </Text>
              <Text 
                size="xs" 
                style={{ color: title.length > TITLE_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.text.tertiary }}
              >
                {title.length}/{TITLE_MAX_LENGTH}
              </Text>
            </Box>
            <input
              type="text"
              placeholder={t('enterTitle')}
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX_LENGTH))}
              maxLength={TITLE_MAX_LENGTH}
              style={{
                width: '100%',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${title.length > TITLE_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.border.primary}`,
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.base,
                outline: 'none',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            />
          </Box>

          <Box>
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <Text size="sm" weight="bold">
                  {t('contentLabel')}
                </Text>
                <Box style={{ display: 'flex', borderRadius: tokens.radius.md, overflow: 'hidden', border: `1px solid ${tokens.colors.border.primary}` }}>
                  <button
                    type="button"
                    onClick={() => setShowPreview(false)}
                    style={{
                      padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                      border: 'none',
                      background: !showPreview ? '#8b6fa8' : 'transparent',
                      color: !showPreview ? '#fff' : tokens.colors.text.secondary,
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
                      borderLeft: `1px solid ${tokens.colors.border.primary}`,
                      background: showPreview ? '#8b6fa8' : 'transparent',
                      color: showPreview ? '#fff' : tokens.colors.text.secondary,
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
                {draftSaved && (
                  <Text size="xs" color="tertiary" style={{ color: '#2fe57d' }}>
                    ✓ {t('draftSaved')}
                  </Text>
                )}
              </Box>
              <Text 
                size="xs" 
                style={{ color: content.length > CONTENT_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.text.tertiary }}
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
                  border: `2px solid #8b6fa8`,
                  background: `linear-gradient(135deg, rgba(139, 111, 168, 0.05) 0%, rgba(139, 111, 168, 0.1) 100%)`,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  position: 'relative',
                }}
              >
                {/* 预览模式标签 */}
                <Box
                  style={{
                    position: 'absolute',
                    top: -12,
                    left: 12,
                    background: '#8b6fa8',
                    color: '#fff',
                    padding: '2px 10px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {t('previewMode')}
                </Box>
                {content ? renderContentWithControls(
                  content,
                  moveImageInContent,
                  removeImageFromContent,
                  (content.match(/!\[image\]\([^)]+\)/g) || []).length,
                  t
                ) : <Text color="tertiary">{t('previewPlaceholder')}</Text>}
              </Box>
            ) : (
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
                maxLength={CONTENT_MAX_LENGTH}
                rows={12}
                style={{
                  width: '100%',
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${content.length > CONTENT_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  outline: 'none',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  resize: 'vertical',
                  lineHeight: 1.6,
                }}
              />
            )}
            {/* Sticker button */}
            <div style={{ position: 'relative', marginTop: tokens.spacing[2] }}>
              <button
                type="button"
                onClick={() => setShowStickerPicker(prev => !prev)}
                style={{
                  background: 'transparent',
                  border: `1px solid ${tokens.colors.border.primary}`,
                  cursor: 'pointer',
                  padding: '4px 10px',
                  borderRadius: 8,
                  color: showStickerPicker ? '#8b6fa8' : tokens.colors.text.tertiary,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
                  <path d="M14 3v4a2 2 0 0 0 2 2h4" />
                </svg>
                {language === 'zh' ? '贴纸' : 'Sticker'}
              </button>
              <DynamicStickerPicker
                isOpen={showStickerPicker}
                onClose={() => setShowStickerPicker(false)}
                onSelect={(sticker: Sticker) => {
                  setContent(prev => prev + `[sticker:${sticker.id}]`)
                  setShowStickerPicker(false)
                }}
              />
            </div>
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
              {t('mentionTip')}
            </Text>
          </Box>

          {/* 投票功能开关 */}
          <Box
            style={{
              padding: tokens.spacing[4],
              borderRadius: tokens.radius.md,
              border: `1px solid ${pollEnabled ? '#8b6fa8' : tokens.colors.border.primary}`,
              background: pollEnabled ? 'rgba(139, 111, 168, 0.1)' : tokens.colors.bg.secondary,
              transition: 'all 0.2s ease',
            }}
          >
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                cursor: 'pointer',
              }}
              onClick={() => setPollEnabled(!pollEnabled)}
            >
              <Box
                style={{
                  width: 44,
                  height: 24,
                  borderRadius: 12,
                  background: pollEnabled ? '#8b6fa8' : tokens.colors.border.primary,
                  position: 'relative',
                  transition: 'background 0.2s ease',
                  flexShrink: 0,
                }}
              >
                <Box
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: '#fff',
                    position: 'absolute',
                    top: 2,
                    left: pollEnabled ? 22 : 2,
                    transition: 'left 0.2s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                />
              </Box>
              <Box>
                <Text size="sm" weight="bold" style={{ color: pollEnabled ? '#8b6fa8' : tokens.colors.text.primary }}>
                  {t('enablePoll')}
                </Text>
                <Text size="xs" color="tertiary">
                  {t('pollDescription')}
                </Text>
              </Box>
            </Box>

            {/* 投票设置 */}
            {pollEnabled && (
              <Box style={{ marginTop: tokens.spacing[4], display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {/* 投票选项 */}
                <Box>
                  <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                    {t('pollOptionsLabel')}
                  </Text>
                  {pollOptions.map((option, index) => (
                    <Box key={index} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
                      <Text size="xs" color="tertiary" style={{ width: 20 }}>{index + 1}.</Text>
                      <input
                        type="text"
                        placeholder={`${t('pollOptionPlaceholder')} ${index + 1}`}
                        value={option.text}
                        onChange={(e) => {
                          const newOptions = [...pollOptions]
                          newOptions[index].text = e.target.value
                          setPollOptions(newOptions)
                        }}
                        style={{
                          flex: 1,
                          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                          borderRadius: tokens.radius.md,
                          border: `1px solid ${tokens.colors.border.primary}`,
                          background: tokens.colors.bg.primary,
                          color: tokens.colors.text.primary,
                          fontSize: tokens.typography.fontSize.sm,
                          outline: 'none',
                        }}
                      />
                      {pollOptions.length > 2 && (
                        <button
                          onClick={() => setPollOptions(pollOptions.filter((_, i) => i !== index))}
                          style={{
                            width: 28,
                            height: 28,
                            border: 'none',
                            background: 'rgba(255,77,77,0.2)',
                            color: '#ff4d4d',
                            borderRadius: tokens.radius.md,
                            cursor: 'pointer',
                            fontSize: 16,
                          }}
                        >
                          ×
                        </button>
                      )}
                    </Box>
                  ))}
                  {pollOptions.length < 6 && (
                    <button
                      onClick={() => setPollOptions([...pollOptions, { text: '', votes: 0 }])}
                      style={{
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        border: `1px dashed ${tokens.colors.border.primary}`,
                        background: 'transparent',
                        color: tokens.colors.text.secondary,
                        borderRadius: tokens.radius.md,
                        cursor: 'pointer',
                        fontSize: tokens.typography.fontSize.sm,
                        width: '100%',
                      }}
                    >
                      + {t('addPollOption')}
                    </button>
                  )}
                </Box>

                {/* 投票类型和持续时间 */}
                <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
                  {/* 投票类型 */}
                  <Box style={{ flex: 1, minWidth: 150 }}>
                    <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                      {t('pollTypeLabel')}
                    </Text>
                    <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                      <button
                        onClick={() => setPollType('single')}
                        style={{
                          flex: 1,
                          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                          border: `1px solid ${pollType === 'single' ? '#8b6fa8' : tokens.colors.border.primary}`,
                          background: pollType === 'single' ? 'rgba(139,111,168,0.2)' : 'transparent',
                          color: pollType === 'single' ? '#8b6fa8' : tokens.colors.text.secondary,
                          borderRadius: tokens.radius.md,
                          cursor: 'pointer',
                          fontSize: tokens.typography.fontSize.xs,
                          fontWeight: 600,
                        }}
                      >
                        {t('singleChoice')}
                      </button>
                      <button
                        onClick={() => setPollType('multiple')}
                        style={{
                          flex: 1,
                          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                          border: `1px solid ${pollType === 'multiple' ? '#8b6fa8' : tokens.colors.border.primary}`,
                          background: pollType === 'multiple' ? 'rgba(139,111,168,0.2)' : 'transparent',
                          color: pollType === 'multiple' ? '#8b6fa8' : tokens.colors.text.secondary,
                          borderRadius: tokens.radius.md,
                          cursor: 'pointer',
                          fontSize: tokens.typography.fontSize.xs,
                          fontWeight: 600,
                        }}
                      >
                        {t('multipleChoice')}
                      </button>
                    </Box>
                  </Box>

                  {/* 持续时间 */}
                  <Box style={{ flex: 1, minWidth: 150 }}>
                    <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                      {t('pollDurationLabel')}
                    </Text>
                    <select
                      value={pollDuration}
                      onChange={(e) => setPollDuration(Number(e.target.value))}
                      style={{
                        width: '100%',
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        borderRadius: tokens.radius.md,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        background: tokens.colors.bg.primary,
                        color: tokens.colors.text.primary,
                        fontSize: tokens.typography.fontSize.sm,
                        outline: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      {POLL_DURATION_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </Box>
                </Box>

                <Text size="xs" color="tertiary">
                  {t('pollResultsNote')}
                </Text>
              </Box>
            )}
          </Box>

          {/* 图片上传区域 */}
          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
              {t('imagesOptional')}
            </Text>
            
            {/* 操作提示 */}
            <Box 
              style={{ 
                padding: tokens.spacing[3],
                marginBottom: tokens.spacing[3],
                background: 'rgba(139, 111, 168, 0.1)',
                borderRadius: tokens.radius.md,
                border: '1px dashed #8b6fa8',
              }}
            >
              <Text size="xs" color="secondary" style={{ display: 'block', marginBottom: 4 }}>
                <strong>{t('imageInsertGuideTitle')}</strong>
              </Text>
              <Text size="xs" color="tertiary" style={{ display: 'block', lineHeight: 1.6 }}>
                {t('imageInsertStep1')}<br />
                {t('imageInsertStep2')} <span style={{ background: '#8b6fa8', color: '#fff', padding: '0 4px', borderRadius: 3 }}>↵</span> {t('imageInsertStep2Suffix')}<br />
                {t('imageInsertStep3')}
              </Text>
            </Box>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
              multiple
              onChange={handleImageUpload}
              style={{ display: 'none' }}
              id="image-upload"
            />
            
            <Box 
              style={{ 
                display: 'flex', 
                flexWrap: 'wrap', 
                gap: tokens.spacing[3],
                marginBottom: tokens.spacing[3],
              }}
            >
              {/* 已上传的图片预览 - 支持拖拽排序 */}
              {images.map((image, index) => {
                const inContent = isImageInContent(image.url)
                return (
                <Box
                  key={image.url}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                  style={{
                    position: 'relative',
                    width: 100,
                    height: 100,
                    borderRadius: tokens.radius.md,
                    overflow: 'hidden',
                    border: inContent 
                      ? `2px solid #8b6fa8`
                      : draggedImageIndex === index 
                        ? `2px solid ${tokens.colors.accent.brand}` 
                        : `1px solid ${tokens.colors.border.primary}`,
                    cursor: 'grab',
                    opacity: draggedImageIndex === index ? 0.7 : 1,
                    transition: 'all 0.2s ease',
                  }}
                >
                  <img
                    src={image.url}
                    alt={`Upload ${index + 1}`}
                    draggable={false}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      pointerEvents: 'none',
                    }}
                  />
                  {/* 已插入标记 */}
                  {inContent && (
                    <Box
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        background: 'rgba(139,111,168,0.9)',
                        color: '#fff',
                        fontSize: 10,
                        textAlign: 'center',
                        padding: '2px 0',
                      }}
                    >
                      {t('inserted')}
                    </Box>
                  )}
                  <Box
                    style={{
                      position: 'absolute',
                      top: 0,
                      right: 0,
                      display: 'flex',
                      gap: 2,
                    }}
                  >
                    <button
                      onClick={() => insertImageToContent(image.url)}
                      title={inContent ? t('reinsertAtCursor') : t('insertAtCursor')}
                      style={{
                        width: 24,
                        height: 24,
                        border: 'none',
                        background: 'rgba(139,111,168,0.9)',
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: 12,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      ↵
                    </button>
                    <button
                      onClick={() => removeImage(index)}
                      title={t('delete')}
                      style={{
                        width: 24,
                        height: 24,
                        border: 'none',
                        background: 'rgba(255,77,77,0.9)',
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: 14,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      ×
                    </button>
                  </Box>
                </Box>
              )})}
              
              {/* 上传按钮 */}
              {images.length < 9 && (
                <label
                  htmlFor="image-upload"
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: tokens.radius.md,
                    border: `2px dashed ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: uploading ? 'not-allowed' : 'pointer',
                    opacity: uploading ? 0.5 : 1,
                    transition: 'all 0.2s ease',
                  }}
                >
                  {uploading ? (
                    <Text size="xs" color="secondary">{t('uploadingImage')}</Text>
                  ) : (
                    <>
                      <Text size="2xl" color="secondary" style={{ lineHeight: 1 }}>+</Text>
                      <Text size="xs" color="secondary">{t('addImage')}</Text>
                    </>
                  )}
                </label>
              )}
            </Box>
            
            <Text size="xs" color="tertiary">
              {t('imageSupport')}
            </Text>
          </Box>

          {/* 视频上传区域 */}
          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
              {t('videoOptional')}
            </Text>

            <input
              ref={videoInputRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/x-msvideo,video/x-matroska"
              onChange={handleVideoUpload}
              style={{ display: 'none' }}
              id="video-upload"
            />

            <Box
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: tokens.spacing[3],
                marginBottom: tokens.spacing[3],
              }}
            >
              {/* 已上传的视频预览 */}
              {videos.map((video) => (
                <Box
                  key={video.url}
                  style={{
                    position: 'relative',
                    width: 200,
                    height: 120,
                    borderRadius: tokens.radius.md,
                    overflow: 'hidden',
                    border: `2px solid #8b6fa8`,
                    background: '#000',
                  }}
                >
                  <video
                    src={video.url}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                  {/* 播放图标 */}
                  <Box
                    style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: 40,
                      height: 40,
                      borderRadius: '50%',
                      background: 'rgba(139, 111, 168, 0.9)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontSize: 18,
                    }}
                  >
                    ▶
                  </Box>
                  {/* 文件大小标签 */}
                  <Box
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      background: 'rgba(139,111,168,0.9)',
                      color: '#fff',
                      fontSize: 10,
                      textAlign: 'center',
                      padding: '2px 0',
                    }}
                  >
                    {(video.fileSize / 1024 / 1024).toFixed(1)}MB
                  </Box>
                  {/* 删除按钮 */}
                  <button
                    onClick={removeVideo}
                    title={t('deleteVideo')}
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      width: 24,
                      height: 24,
                      border: 'none',
                      background: 'rgba(255,77,77,0.9)',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 14,
                      borderRadius: 4,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    ×
                  </button>
                </Box>
              ))}

              {/* 上传按钮 */}
              {videos.length < 1 && (
                <label
                  htmlFor="video-upload"
                  style={{
                    width: 200,
                    height: 120,
                    borderRadius: tokens.radius.md,
                    border: `2px dashed ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: videoUploading ? 'not-allowed' : 'pointer',
                    opacity: videoUploading ? 0.5 : 1,
                    transition: 'all 0.2s ease',
                  }}
                >
                  {videoUploading ? (
                    <Box style={{ textAlign: 'center' }}>
                      <Text size="xs" color="secondary">{t('uploadingImage')} {videoUploadProgress}%</Text>
                      {/* 进度条 */}
                      <Box
                        style={{
                          width: 150,
                          height: 4,
                          background: tokens.colors.border.primary,
                          borderRadius: 2,
                          marginTop: 8,
                          overflow: 'hidden',
                        }}
                      >
                        <Box
                          style={{
                            width: `${videoUploadProgress}%`,
                            height: '100%',
                            background: '#8b6fa8',
                            transition: 'width 0.3s ease',
                          }}
                        />
                      </Box>
                    </Box>
                  ) : (
                    <>
                      <Text size="2xl" color="secondary" style={{ lineHeight: 1 }}>Video</Text>
                      <Text size="xs" color="secondary" style={{ marginTop: 4 }}>{t('addVideo')}</Text>
                      <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>MP4, WebM, MOV</Text>
                    </>
                  )}
                </label>
              )}
            </Box>

            <Text size="xs" color="tertiary">
              {t('videoFormatSupport')}
            </Text>
          </Box>

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
            >
              {loading ? t('publishing') : t('publish')}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}



