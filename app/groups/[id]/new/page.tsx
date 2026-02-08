'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import { renderContentWithLinks } from '@/lib/utils/content'
import { DynamicStickerPicker } from '@/app/components/ui/Dynamic'
import type { Sticker } from '@/lib/stickers'

interface UploadedImage {
  url: string
  fileName: string
}

interface UploadedVideo {
  url: string
  fileName: string
  fileSize?: number
  thumbnail?: string
}

interface PollOption {
  text: string
  votes: number
}

const TITLE_MAX_LENGTH = 100
const CONTENT_MAX_LENGTH = 10000
const DRAFT_KEY_PREFIX = 'group_post_draft_'
const MAX_IMAGES = 9
const MAX_VIDEO_SIZE_MB = 100
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']

const POLL_DURATION_OPTIONS = [
  { label: '1小时', value: 1 },
  { label: '6小时', value: 6 },
  { label: '12小时', value: 12 },
  { label: '1天', value: 24 },
  { label: '3天', value: 72 },
  { label: '7天', value: 168 },
]

// Shared input style
const inputStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: tokens.radius.md,
  border: ('1px solid ' + tokens.colors.border.primary),
  background: tokens.colors.bg.secondary,
  color: tokens.colors.text.primary,
  fontSize: tokens.typography.fontSize.base,
  outline: 'none',
  fontFamily: tokens.typography.fontFamily.sans.join(', '),
}

// Character count component
interface CharCountProps {
  current: number
  max: number
}

function CharCount({ current, max }: CharCountProps): React.ReactElement {
  const isOver = current > max
  return (
    <Text size="xs" style={{ color: isOver ? tokens.colors.accent.error : tokens.colors.text.tertiary }}>
      {current}/{max}
    </Text>
  )
}

// Toggle switch component
interface ToggleSwitchProps {
  enabled: boolean
  onToggle: () => void
  label: string
  description?: string
}

function ToggleSwitch({ enabled, onToggle, label, description }: ToggleSwitchProps): React.ReactElement {
  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
        padding: tokens.spacing[4],
        borderRadius: tokens.radius.md,
        border: ('1px solid ' + enabled ? tokens.colors.accent.brand : tokens.colors.border.primary),
        background: enabled ? 'rgba(139, 111, 168, 0.1)' : tokens.colors.bg.secondary,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
      }}
      onClick={onToggle}
    >
      <Box
        style={{
          width: 44,
          height: 24,
          borderRadius: 12,
          background: enabled ? tokens.colors.accent.brand : tokens.colors.border.primary,
          position: 'relative',
          transition: 'background 0.2s ease',
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
            left: enabled ? 22 : 2,
            transition: 'left 0.2s ease',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }}
        />
      </Box>
      <Box>
        <Text size="sm" weight="bold" style={{ color: enabled ? tokens.colors.accent.brand : tokens.colors.text.primary }}>
          {label}
        </Text>
        {description && <Text size="xs" color="tertiary">{description}</Text>}
      </Box>
    </Box>
  )
}

export default function NewGroupPostPage(): React.ReactElement {
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
  const [videos, setVideos] = useState<UploadedVideo[]>([])
  const [videoUploading, setVideoUploading] = useState(false)
  const [videoUploadProgress, setVideoUploadProgress] = useState(0)

  // Link preview state (UF15)
  const [linkPreview, setLinkPreview] = useState<{ url: string; title: string; description: string; image: string } | null>(null)
  const [linkPreviewLoading, setLinkPreviewLoading] = useState(false)
  const linkPreviewUrlRef = useRef<string | null>(null)

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
    // 等待 groupId 解析完成
    if (!groupId) return

    supabase.auth.getUser().then(async ({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)

      if (!data.user) {
        router.push('/login')
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
        console.error('Membership check error:', membershipError)
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
  }, [router, groupId, showToast, language])

  // 加载小组名称
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
      console.error('Error loading user handle:', error)
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
          console.error('Failed to parse draft:', e)
        }
      }
    }
  }, [groupId, draftKey, showToast, t])

  // Auto-save draft to localStorage (debounced)
  useEffect(() => {
    if (typeof window === 'undefined' || !groupId) return
    
    const saveTimer = setTimeout(() => {
      if (title.trim() || content.trim()) {
        localStorage.setItem(draftKey, JSON.stringify({ title, content, images, pollEnabled }))
        setDraftSaved(true)
        setTimeout(() => setDraftSaved(false), 2000)
      }
    }, 1000)

    return () => clearTimeout(saveTimer)
  }, [title, content, images, pollEnabled, groupId, draftKey])

  // UF15: Detect URLs in content and fetch link preview
  useEffect(() => {
    const urlMatch = content.match(/https?:\/\/[^\s)]+/)
    const url = urlMatch ? urlMatch[0] : null
    if (url && url !== linkPreviewUrlRef.current) {
      linkPreviewUrlRef.current = url
      setLinkPreviewLoading(true)
      fetch(`/api/posts/link-preview?url=${encodeURIComponent(url)}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data && (data.title || data.description)) {
            setLinkPreview({ url, ...data })
          } else {
            setLinkPreview(null)
          }
        })
        .catch(() => setLinkPreview(null))
        .finally(() => setLinkPreviewLoading(false))
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
    const newImages: UploadedImage[] = []

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
        const formData = new FormData()
        formData.append('file', file)
        formData.append('userId', userId)

        const response = await fetch('/api/posts/upload-image', {
          method: 'POST',
          headers: getCsrfHeaders(),
          body: formData,
        })

        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          showToast(`${file.name}: ${data.error || `${t('uploadFailed')} (${response.status})`}`, 'error')
          continue
        }

        const data = await response.json()
        newImages.push({ url: data.url, fileName: data.fileName })
      } catch (error) {
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
      console.error('Video upload error:', error)
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
    // 防止双重提交
    if (submitRef.current || loading) return

    if (!title.trim()) {
      showToast(t('pleaseEnterTitle'), 'warning')
      return
    }

    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      router.push('/login')
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
      }).select('id').single()

      if (error) {
        console.error('Post creation error:', error)
        const errorMsg = error.code === '42501'
          ? t('permissionDeniedJoinGroup')
          : (error.message || t('createPostFailed'))
        showToast(errorMsg, 'error')
        setLoading(false)
        submitRef.current = false
        return
      }

      console.warn('Post created successfully:', postData?.id)

      clearDraft()
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
              style={{ ...inputStyle, padding: `${tokens.spacing[3]} ${tokens.spacing[4]}` }}
            />
          </Box>

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
                      borderLeft: ('1px solid ' + tokens.colors.border.primary),
                      background: showPreview ? tokens.colors.accent.brand : 'transparent',
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
                    [Saved] {t('draftSaved')}
                  </Text>
                )}
              </Box>
              <CharCount current={content.length} max={CONTENT_MAX_LENGTH} />
            </Box>
            
            {showPreview ? (
              <Box
                style={{
                  width: '100%',
                  minHeight: 288,
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.md,
                  border: ('2px solid ' + tokens.colors.accent.brand),
                  background: `linear-gradient(135deg, rgba(139, 111, 168, 0.05) 0%, rgba(139, 111, 168, 0.1) 100%)`,
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
                placeholder={t('enterContent')}
                value={content}
                onChange={(e) => setContent(e.target.value.slice(0, CONTENT_MAX_LENGTH))}
                maxLength={CONTENT_MAX_LENGTH}
                rows={12}
                style={{ ...inputStyle, padding: tokens.spacing[4], resize: 'vertical', lineHeight: 1.6 }}
              />
            )}
            {/* UF15: Link Preview Card */}
            {linkPreviewLoading && (
              <Box style={{ marginTop: tokens.spacing[2], padding: tokens.spacing[3], borderRadius: tokens.radius.md, background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}` }}>
                <Text size="xs" color="tertiary">{language === 'zh' ? '正在获取链接预览...' : 'Fetching link preview...'}</Text>
              </Box>
            )}
            {linkPreview && !linkPreviewLoading && (
              <Box style={{
                marginTop: tokens.spacing[2], padding: tokens.spacing[3], borderRadius: tokens.radius.md,
                background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
                display: 'flex', gap: tokens.spacing[3], alignItems: 'flex-start',
              }}>
                {linkPreview.image && (
                  <img src={linkPreview.image} alt="" style={{ width: 80, height: 60, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                )}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" weight="bold" style={{ marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {linkPreview.title}
                  </Text>
                  {linkPreview.description && (
                    <Text size="xs" color="secondary" style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
                      {linkPreview.description}
                    </Text>
                  )}
                  <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>{new URL(linkPreview.url).hostname}</Text>
                </Box>
                <button onClick={() => { setLinkPreview(null); linkPreviewUrlRef.current = 'dismissed' }}
                  style={{ background: 'none', border: 'none', color: tokens.colors.text.tertiary, cursor: 'pointer', fontSize: 16, padding: 2 }}>×</button>
              </Box>
            )}
            {/* Sticker button */}
            <div style={{ position: 'relative', marginTop: tokens.spacing[2] }}>
              <button
                type="button"
                onClick={() => setShowStickerPicker(prev => !prev)}
                style={{
                  background: 'transparent',
                  border: ('1px solid ' + tokens.colors.border.primary),
                  cursor: 'pointer',
                  padding: '4px 10px',
                  borderRadius: 8,
                  color: showStickerPicker ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
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
                  setContent(prev => prev + ('[sticker:' + sticker.id + ']'))
                  setShowStickerPicker(false)
                }}
              />
            </div>
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
              {t('mentionTip')}
            </Text>
          </Box>

          <ToggleSwitch
            enabled={pollEnabled}
            onToggle={() => setPollEnabled(!pollEnabled)}
            label={t('enablePoll')}
            description={t('pollDescription')}
          />

          {/* 投票设置 */}
          {pollEnabled && (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
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
                        border: ('1px solid ' + tokens.colors.border.primary),
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
                      border: ('1px dashed ' + tokens.colors.border.primary),
                      background: 'transparent',
                      color: tokens.colors.text.secondary,
                      borderRadius: tokens.radius.md,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.sm,
                      width: '100%',
                    }}
                  >
                    + {t('addOption')}
                  </button>
                )}
              </Box>

              <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
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
                        borderRadius: tokens.radius.md,
                        border: ('1px solid ' + pollType === 'single' ? tokens.colors.accent.brand : tokens.colors.border.primary),
                        background: pollType === 'single' ? 'rgba(139, 111, 168, 0.2)' : 'transparent',
                        color: pollType === 'single' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
                        cursor: 'pointer',
                        fontSize: tokens.typography.fontSize.sm,
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
                        borderRadius: tokens.radius.md,
                        border: ('1px solid ' + pollType === 'multiple' ? tokens.colors.accent.brand : tokens.colors.border.primary),
                        background: pollType === 'multiple' ? 'rgba(139, 111, 168, 0.2)' : 'transparent',
                        color: pollType === 'multiple' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
                        cursor: 'pointer',
                        fontSize: tokens.typography.fontSize.sm,
                        fontWeight: 600,
                      }}
                    >
                      {t('multipleChoice')}
                    </button>
                  </Box>
                </Box>

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
                      border: ('1px solid ' + tokens.colors.border.primary),
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
            </Box>
          )}

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
              {images.map((image, index) => (
                <Box
                  key={index}
                  style={{
                    position: 'relative',
                    width: 100,
                    height: 100,
                    borderRadius: tokens.radius.md,
                    overflow: 'hidden',
                    border: ('1px solid ' + tokens.colors.border.primary),
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
                      title={t('imageInserted') || (language === 'zh' ? '插入到内容' : 'Insert to content')}
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
                      title={language === 'zh' ? '删除' : 'Delete'}
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
              
              {images.length < 9 && (
                <label
                  htmlFor="image-upload"
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: tokens.radius.md,
                    border: ('2px dashed ' + tokens.colors.border.primary),
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
                    border: ('2px solid ' + tokens.colors.accent.brand),
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
                    Play
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
                    {video.fileSize ? (video.fileSize / 1024 / 1024).toFixed(1) : '?'}MB
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
                    border: ('2px dashed ' + tokens.colors.border.primary),
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
                      <Text size="xs" color="secondary">{t('uploadingProgress').replace('{percent}', String(videoUploadProgress))}</Text>
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
                            background: tokens.colors.accent.brand,
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
