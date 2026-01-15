'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/UI/Toast'

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

// 链接解析函数
function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)
  
  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0 // Reset regex state
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
  const fileInputRef = useRef<HTMLInputElement>(null)

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
  const [pollDuration, setPollDuration] = useState(24) // 默认1天
  const [pollType, setPollType] = useState<'single' | 'multiple'>('single')

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
            showToast('已恢复草稿', 'info')
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
      showToast('请先登录', 'warning')
      return
    }

    if (images.length + files.length > 9) {
      showToast('最多上传9张图片', 'warning')
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

  // 插入图片到内容
  const insertImageToContent = (url: string) => {
    const imageMarkdown = `\n![image](${url})\n`
    setContent(prev => prev + imageMarkdown)
    showToast('图片已插入到内容', 'info')
  }

  const handleSubmit = async () => {
    if (!title.trim()) {
      showToast('请输入标题', 'warning')
      return
    }

    if (!userId) {
      showToast('请先登录', 'warning')
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
      showToast('无权发布', 'error')
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

      const { error } = await supabase.from('posts').insert({
        title,
        content: finalContent,
        author_handle: decodedHandle,
        // group_id 为 null，表示这是个人动态
        author_id: userId,
        images: images.map(img => img.url),
        poll_enabled: pollEnabled,
      })

      if (error) {
        console.error('创建帖子失败:', error)
        showToast(error.message, 'error')
        return
      }

      // Clear draft after successful publish
      clearDraft()
      showToast('发布成功！', 'success')
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
          发动态
        </Text>
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
          分享你的交易想法和见解
        </Text>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          <Box>
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
              <Text size="sm" weight="bold">
                标题
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
              placeholder="输入标题..."
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
                  内容
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
                    ✏️ 编辑
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
                    👁️ 预览
                  </button>
                </Box>
                {draftSaved && (
                  <Text size="xs" color="tertiary" style={{ color: '#2fe57d' }}>
                    ✓ 草稿已保存
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
                  预览模式
                </Box>
                {content ? renderContentWithLinks(content) : <Text color="tertiary">预览内容将显示在这里...</Text>}
              </Box>
            ) : (
              <textarea
                placeholder="输入内容... (支持使用 @用户名 提及其他用户，链接将自动变为可点击)"
                value={content}
                onChange={(e) => setContent(e.target.value.slice(0, CONTENT_MAX_LENGTH))}
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
              提示：使用 @用户名 可以提及其他用户，链接会自动变为可点击
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
                  📊 开启投票
                </Text>
                <Text size="xs" color="tertiary">
                  自定义投票选项，到期自动公布结果
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
              {/* 已上传的图片预览 */}
              {images.map((image, index) => (
                <Box
                  key={index}
                  style={{
                    position: 'relative',
                    width: 100,
                    height: 100,
                    borderRadius: tokens.radius.md,
                    overflow: 'hidden',
                    border: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  <img
                    src={image.url}
                    alt={`Upload ${index + 1}`}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
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
                    <Text size="xs" color="secondary">上传中...</Text>
                  ) : (
                    <>
                      <Text size="2xl" color="secondary" style={{ lineHeight: 1 }}>+</Text>
                      <Text size="xs" color="secondary">添加图片</Text>
                    </>
                  )}
                </label>
              )}
            </Box>
            
            <Text size="xs" color="tertiary">
              支持 JPG、PNG、GIF、WebP 格式，单张最大 5MB
            </Text>
          </Box>

          <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
            <Button
              variant="ghost"
              size="md"
              onClick={() => router.back()}
              disabled={loading}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleSubmit}
              disabled={loading || !title.trim()}
            >
              {loading ? '发布中...' : '发布'}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}



