'use client'

import { features } from '@/lib/features'
import { notFound } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

interface UploadedImage {
  url: string
  fileName: string
}

const TITLE_MAX_LENGTH = 100
const CONTENT_MAX_LENGTH = 10000

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
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              color: tokens.colors.accent.brand,
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
  const parts: { type: 'text' | 'image' | 'link'; content: string; url?: string; imageIndex?: number }[] = []
  let currentIndex = 0
  
  for (const img of imageMatches) {
    if (img.start > currentIndex) {
      const beforeText = text.slice(currentIndex, img.start)
      const linkParts = beforeText.split(urlRegex)
      linkParts.forEach((part) => {
        if (urlRegex.test(part)) {
          urlRegex.lastIndex = 0
          parts.push({ type: 'link', content: part, url: part })
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
        parts.push({ type: 'link', content: part, url: part })
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
              borderRadius: tokens.radius.md,
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
            background: 'var(--color-backdrop-medium)',
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
                background: isFirst ? 'var(--color-overlay-dark)' : 'var(--color-accent-primary)',
                color: tokens.colors.white,
                cursor: isFirst ? 'not-allowed' : 'pointer',
                fontSize: 14,
                borderRadius: tokens.radius.sm,
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
                background: isLast ? 'var(--color-overlay-dark)' : 'var(--color-accent-primary)',
                color: tokens.colors.white,
                cursor: isLast ? 'not-allowed' : 'pointer',
                fontSize: 14,
                borderRadius: tokens.radius.sm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ↓
            </button>
            <button aria-label="Close"
              onClick={(e) => { e.stopPropagation(); onRemoveImage(part.url!) }}
              title={t('remove')}
              style={{
                width: 24,
                height: 24,
                border: 'none',
                background: 'var(--color-accent-error)',
                color: tokens.colors.white,
                cursor: 'pointer',
                fontSize: 14,
                borderRadius: tokens.radius.sm,
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
    if (part.type === 'link') {
      return (
        <a
          key={index}
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: tokens.colors.accent.brand,
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

export default function EditPostPage() {
  if (!features.social) notFound()

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

  // 获取用户信息
  useEffect(() => {
     
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for edit page init */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [])

  // 加载帖子数据
  useEffect(() => {
    if (!postId || !userId) return

    const loadPost = async () => {
      setLoading(true)
      try {
        const { data: post, error } = await supabase
          .from('posts')
          .select('id, title, content, author_handle, author_id, image_url, images, image_urls, link_url, link_title, link_description, link_image, poll_options, poll_votes, poll_end_at, group_id, tags, visibility, created_at, updated_at')
          .eq('id', postId)
          .single()

        if (error) {
          logger.error('Error loading post:', error)
          showToast(t('loadPostFailed'), 'error')
          router.push('/my-posts')
          return
        }

        // 验证所有权
        if (post.author_id !== userId) {
          showToast(t('noPermissionEditPost'), 'error')
          router.push('/my-posts')
          return
        }

        setOriginalPost(post)
        setTitle(post.title || '')
        setContent(post.content || '')
        // 兼容 images 和 image_urls 两种字段名
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

  // 移除图片
  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  // 插入图片到内容（在光标位置）
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

  // 移动图片在内容中的位置（上移或下移）
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

  // 图片拖拽排序
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

  // 提交更新
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
      // 如果有图片但没有插入到内容中，自动附加到内容末尾
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

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    )
  }

  if (!originalPost) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="lg" color="secondary">{t('postNotFoundOrNoPermission')}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
          {t('editPost')}
        </Text>
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
          {t('editPostDescription')}
        </Text>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {/* 标题 */}
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && title.trim()) {
                  e.preventDefault()
                  textareaRef.current?.focus()
                }
              }}
              maxLength={TITLE_MAX_LENGTH}
              autoFocus
              style={{
                width: '100%',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: '1px solid ' + (title.length > TITLE_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.border.primary),
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.base,
                outline: 'none',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            />
          </Box>

          {/* 内容 */}
          <Box>
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <Text size="sm" weight="bold">
                  {t('contentLabel')}
                </Text>
                <Box style={{ display: 'flex', borderRadius: tokens.radius.md, overflow: 'hidden', border: ('1px solid ' + tokens.colors.border.primary) }}>
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
                      borderLeft: ('1px solid ' + tokens.colors.border.primary),
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
                  border: ('2px solid ' + tokens.colors.accent.brand),
                  background: `linear-gradient(135deg, var(--color-accent-primary-08) 0%, var(--color-accent-primary-10) 100%)`,
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
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && title.trim() && !saving) {
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
                  border: '1px solid ' + (content.length > CONTENT_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.border.primary),
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
          </Box>

          {/* 图片上传区域 */}
          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
              {t('imagesOptional')}
            </Text>
            
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
              multiple
              onChange={handleImageUpload}
              style={{ display: 'none' }}
            />
            
            {/* 操作提示 */}
            <Box 
              style={{ 
                padding: tokens.spacing[3],
                marginBottom: tokens.spacing[3],
                background: 'var(--color-accent-primary-10)',
                borderRadius: tokens.radius.md,
                border: ('1px dashed ' + tokens.colors.accent.brand),
              }}
            >
              <Text size="xs" color="secondary" style={{ display: 'block', marginBottom: 4 }}>
                <strong>{t('imageInsertGuideTitle')}</strong>
              </Text>
              <Text size="xs" color="tertiary" style={{ display: 'block', lineHeight: 1.6 }}>
                {t('imageInsertStep1')}<br />
                {t('imageInsertStep2')} <span style={{ background: tokens.colors.accent.brand, color: tokens.colors.white, padding: '0 4px', borderRadius: 3 }}>↵</span> {t('imageInsertStep2Suffix')}<br />
                {t('imageInsertStep3')}
              </Text>
            </Box>
            
            <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
              {images.map((img, index) => {
                const inContent = isImageInContent(img.url)
                return (
                <Box
                  key={img.url}
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
                      ? ('2px solid ' + tokens.colors.accent.brand)
                      : draggedImageIndex === index 
                        ? ('2px solid ' + tokens.colors.accent.brand) 
                        : ('1px solid ' + tokens.colors.border.primary),
                    cursor: 'grab',
                    opacity: draggedImageIndex === index ? 0.7 : 1,
                    transition: `all ${tokens.transition.base}`,
                  }}
                >
                  <Image
                    src={img.url}
                    alt={img.fileName}
                    width={120}
                    height={120}
                    draggable={false}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
                    unoptimized
                  />
                  {/* 已插入标记 */}
                  {inContent && (
                    <Box
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        background: 'var(--color-accent-primary)',
                        color: tokens.colors.white,
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
                      top: 4,
                      right: 4,
                      display: 'flex',
                      gap: 4,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => insertImageToContent(img.url)}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: '50%',
                        border: 'none',
                        background: 'var(--color-accent-primary)',
                        color: tokens.colors.white,
                        fontSize: 12,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      title={inContent ? t('reinsertAtCursor') : t('insertAtCursor')}
                    >
                      ↵
                    </button>
                    <button aria-label="Close"
                      type="button"
                      onClick={() => removeImage(index)}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: '50%',
                        border: 'none',
                        background: 'var(--color-accent-error)',
                        color: tokens.colors.white,
                        fontSize: 12,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      title={t('deleteImage')}
                    >
                      ×
                    </button>
                  </Box>
                </Box>
              )})}
              
              {images.length < 9 && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: tokens.radius.md,
                    border: ('2px dashed ' + tokens.colors.border.primary),
                    background: 'transparent',
                    color: tokens.colors.text.tertiary,
                    fontSize: 32,
                    cursor: uploading ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: uploading ? 0.5 : 1,
                  }}
                >
                  {uploading ? '...' : '+'}
                </button>
              )}
            </Box>
          </Box>

          {/* 操作按钮 */}
          <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: tokens.spacing[3], marginTop: tokens.spacing[4] }}>
            <Button
              variant="secondary"
              onClick={() => router.push('/my-posts')}
              disabled={saving}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={saving || !title.trim()}
            >
              {saving ? t('savingChanges') : t('saveChanges')}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

