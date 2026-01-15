'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/UI/Toast'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

interface UploadedImage {
  url: string
  fileName: string
}

interface PollOption {
  text: string
  votes: number
}

const TITLE_MAX_LENGTH = 100
const CONTENT_MAX_LENGTH = 10000
const DRAFT_KEY_PREFIX = 'post_draft_'

// 投票持续时间选项
const POLL_DURATION_OPTIONS = [
  { label: '1小时', value: 1 },
  { label: '6小时', value: 6 },
  { label: '12小时', value: 12 },
  { label: '1天', value: 24 },
  { label: '3天', value: 72 },
  { label: '7天', value: 168 },
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
        title={type === 'youtube' ? 'YouTube 视频' : 'Bilibili 视频'}
      />
    </div>
  )
}

// 链接解析函数（支持视频嵌入）
function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)
  
  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0 // Reset regex state
      
      // 检查是否是视频链接
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

export default function NewPostPage() {
  const params = useParams<{ handle: string }>()
  const handle = params.handle as string
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [cursorPosition, setCursorPosition] = useState<number | null>(null)

  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
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
        showToast(`${file.name} 格式不支持`, 'error')
        continue
      }

      // 验证文件大小 (5MB)
      if (file.size > 5 * 1024 * 1024) {
        showToast(`${file.name} 超过5MB`, 'error')
        continue
      }

      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('userId', userId)

        const response = await fetch('/api/posts/upload-image', {
          method: 'POST',
          body: formData,
        })

        const data = await response.json()

        if (!response.ok) {
          showToast(data.error || '上传失败', 'error')
          continue
        }

        newImages.push({
          url: data.url,
          fileName: data.fileName,
        })
      } catch (error) {
        console.error('Upload error:', error)
        showToast('上传失败', 'error')
      }
    }

    if (newImages.length > 0) {
      setImages(prev => [...prev, ...newImages])
      showToast(`成功上传 ${newImages.length} 张图片`, 'success')
    }

    setUploading(false)
    // 清空 file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
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

  // 保存光标位置
  const handleTextareaSelect = () => {
    if (textareaRef.current) {
      setCursorPosition(textareaRef.current.selectionStart)
    }
  }

  const handleSubmit = async () => {
    if (!title.trim()) {
      showToast(t('pleaseEnterTitle'), 'warning')
      return
    }

    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      router.push('/login')
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

      // 如果开启投票，先创建投票
      let pollId = null
      if (pollEnabled) {
        // 验证投票选项
        const validOptions = pollOptions.filter(opt => opt.text.trim())
        if (validOptions.length < 2) {
          showToast('请至少填写2个投票选项', 'warning')
          setLoading(false)
          return
        }

        // 计算截止时间（0表示永久，不设置截止时间）
        const endAt = pollDuration > 0 
          ? new Date(Date.now() + pollDuration * 60 * 60 * 1000).toISOString()
          : null

        // 创建投票
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
            end_at: endAt,
          })
          .select('id')
          .single()

        if (pollError) {
          console.error('创建投票失败:', pollError)
          showToast('创建投票失败: ' + pollError.message, 'error')
          setLoading(false)
          return
        }
        pollId = pollData.id
      }

      const { error } = await supabase.from('posts').insert({
        title,
        content: finalContent,
        author_handle: decodedHandle,
        // group_id 为 null，表示这是个人动态
        author_id: userId,
        images: images.map(img => img.url),
        poll_enabled: pollEnabled,
        poll_id: pollId,
      })

      if (error) {
        console.error('创建帖子失败:', JSON.stringify(error, null, 2))
        console.error('Error details - code:', error.code, 'message:', error.message, 'hint:', error.hint)
        showToast(error.message || '创建失败，请检查权限', 'error')
        return
      }

      // Clear draft after successful publish
      clearDraft()
      showToast(t('publishSuccess'), 'success')
      router.push(`/u/${encodeURIComponent(decodedHandle)}`)
    } catch (error: any) {
      console.error('发布异常:', error)
      showToast(error?.message || '发布失败', 'error')
    } finally {
      setLoading(false)
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
                    ✏️ {t('edit')}
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
                    👁️ {t('preview')}
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
                {content ? renderContentWithLinks(content) : <Text color="tertiary">{t('previewPlaceholder')}</Text>}
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
                  📊 {t('enablePoll')}
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
                    投票选项（至少2个，最多6个）
                  </Text>
                  {pollOptions.map((option, index) => (
                    <Box key={index} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
                      <Text size="xs" color="tertiary" style={{ width: 20 }}>{index + 1}.</Text>
                      <input
                        type="text"
                        placeholder={`选项 ${index + 1}`}
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
                      + 添加选项
                    </button>
                  )}
                </Box>

                {/* 投票类型和持续时间 */}
                <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
                  {/* 投票类型 */}
                  <Box style={{ flex: 1, minWidth: 150 }}>
                    <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                      投票类型
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
                        单选
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
                        多选
                      </button>
                    </Box>
                  </Box>

                  {/* 持续时间 */}
                  <Box style={{ flex: 1, minWidth: 150 }}>
                    <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                      投票持续时间
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
                  💡 投票结果在用户投票后或截止时间后才会显示
                </Text>
              </Box>
            )}
          </Box>

          {/* 图片上传区域 */}
          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
              图片（可选，最多9张）
            </Text>
            
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
              {images.map((image, index) => (
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
                    border: draggedImageIndex === index 
                      ? `2px solid ${tokens.colors.brand}` 
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
                      title="插入到内容"
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
                      title="删除"
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
              ))}
              
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



