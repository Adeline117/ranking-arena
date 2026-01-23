'use client'

import { Suspense, useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import ExchangeConnectionManager from '@/app/components/exchange/ExchangeConnection'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { uiLogger } from '@/lib/utils/logger'

// Constants
const MAX_BIO_LENGTH = 200
const MAX_HANDLE_LENGTH = 30

// Section IDs for navigation
type SectionId = 'profile' | 'security' | 'exchanges' | 'notifications' | 'privacy' | 'account'

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'profile', label: '个人资料', icon: '👤' },
  { id: 'security', label: '账号安全', icon: '🔒' },
  { id: 'exchanges', label: '交易所绑定', icon: '🔗' },
  { id: 'notifications', label: '通知偏好', icon: '🔔' },
  { id: 'privacy', label: '隐私设置', icon: '🛡️' },
  { id: 'account', label: '账号管理', icon: '⚙️' },
]

// Validation functions
function validateHandle(handle: string): { valid: boolean; message: string } {
  if (!handle) return { valid: true, message: '' }
  if (handle.length < 2) {
    return { valid: false, message: '用户名至少需要2个字符' }
  }
  if (handle.length > MAX_HANDLE_LENGTH) {
    return { valid: false, message: `用户名不能超过${MAX_HANDLE_LENGTH}个字符` }
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(handle)) {
    return { valid: false, message: '用户名只能包含字母、数字、下划线和中文' }
  }
  return { valid: true, message: '' }
}

function validateEmail(email: string): { valid: boolean; message: string } {
  if (!email) return { valid: true, message: '' }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return { valid: false, message: '请输入有效的邮箱地址' }
  }
  return { valid: true, message: '' }
}

function validatePassword(password: string): { valid: boolean; message: string } {
  if (!password) return { valid: true, message: '' }
  if (password.length < 6) {
    return { valid: false, message: '密码至少需要6个字符' }
  }
  return { valid: true, message: '' }
}

function validatePasswordMatch(password: string, confirmPassword: string): { valid: boolean; message: string } {
  if (!confirmPassword) return { valid: true, message: '' }
  if (password !== confirmPassword) {
    return { valid: false, message: '两次输入的密码不一致' }
  }
  return { valid: true, message: '' }
}

// Toggle switch component
function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        padding: 2,
        border: 'none',
        background: checked ? '#8b6fa8' : tokens.colors.bg.tertiary,
        cursor: 'pointer',
        transition: 'background 0.2s ease',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'block',
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          transform: checked ? 'translateX(18px)' : 'translateX(0)',
          transition: 'transform 0.2s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}
      />
    </button>
  )
}

// Reusable section card component
function SectionCard({
  id,
  title,
  description,
  children,
  variant = 'default',
}: {
  id: string
  title: string
  description?: string
  children: React.ReactNode
  variant?: 'default' | 'danger'
}) {
  return (
    <Box
      id={id}
      style={{
        marginBottom: tokens.spacing[6],
        padding: tokens.spacing[6],
        borderRadius: tokens.radius.xl,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${variant === 'danger' ? tokens.colors.accent.error + '30' : tokens.colors.border.primary}`,
      }}
    >
      <Text
        size="lg"
        weight="black"
        style={{
          marginBottom: description ? tokens.spacing[1] : tokens.spacing[4],
          color: variant === 'danger' ? tokens.colors.accent.error : tokens.colors.text.primary,
        }}
      >
        {title}
      </Text>
      {description && (
        <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
          {description}
        </Text>
      )}
      {children}
    </Box>
  )
}

// Reusable input styles
function getInputStyle(hasError = false) {
  return {
    width: '100%',
    padding: tokens.spacing[3],
    borderRadius: tokens.radius.md,
    border: `1px solid ${hasError ? tokens.colors.accent.error : tokens.colors.border.primary}`,
    background: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.base,
    fontFamily: tokens.typography.fontFamily.sans.join(', '),
    outline: 'none',
    transition: 'border-color 0.2s ease',
  }
}

function SettingsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('profile')

  // Profile data
  const [handle, setHandle] = useState('')
  const [bio, setBio] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null)

  // Initial values for tracking changes
  const initialValuesRef = useRef<{
    handle: string
    bio: string
    avatarUrl: string | null
    coverUrl: string | null
    notifyFollow: boolean
    notifyLike: boolean
    notifyComment: boolean
    notifyMention: boolean
    notifyMessage: boolean
    showFollowers: boolean
    showFollowing: boolean
    dmPermission: string
    showProBadge: boolean
  } | null>(null)

  // Password change
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordResetMode, setPasswordResetMode] = useState<'password' | 'code'>('password')
  const [resetCodeSent, setResetCodeSent] = useState(false)
  const [sendingResetCode, setSendingResetCode] = useState(false)
  const [resetCountdown, setResetCountdown] = useState(0)

  // Email change
  const [newEmail, setNewEmail] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)

  // Notification preferences
  const [notifyFollow, setNotifyFollow] = useState(true)
  const [notifyLike, setNotifyLike] = useState(true)
  const [notifyComment, setNotifyComment] = useState(true)
  const [notifyMention, setNotifyMention] = useState(true)
  const [notifyMessage, setNotifyMessage] = useState(true)
  const [savingNotifications, setSavingNotifications] = useState(false)

  // Privacy settings
  const [showFollowers, setShowFollowers] = useState(true)
  const [showFollowing, setShowFollowing] = useState(true)
  const [dmPermission, setDmPermission] = useState<'all' | 'mutual' | 'none'>('all')
  const [showProBadge, setShowProBadge] = useState(true)

  // Handle uniqueness check
  const [handleAvailable, setHandleAvailable] = useState<boolean | null>(null)
  const [checkingHandle, setCheckingHandle] = useState(false)
  const handleCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Debounced handle uniqueness check
  useEffect(() => {
    if (!handle || handle.length < 2 || !validateHandle(handle).valid) {
      setHandleAvailable(null)
      return
    }
    // Don't check if it's the same as initial
    if (initialValuesRef.current && handle === initialValuesRef.current.handle) {
      setHandleAvailable(null)
      return
    }

    if (handleCheckTimeoutRef.current) {
      clearTimeout(handleCheckTimeoutRef.current)
    }

    setCheckingHandle(true)
    handleCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from('user_profiles')
          .select('id')
          .eq('handle', handle)
          .neq('id', userId || '')
          .maybeSingle()

        setHandleAvailable(!data)
      } catch {
        setHandleAvailable(null)
      } finally {
        setCheckingHandle(false)
      }
    }, 500)

    return () => {
      if (handleCheckTimeoutRef.current) {
        clearTimeout(handleCheckTimeoutRef.current)
      }
    }
  }, [handle, userId])

  // Validation state
  const [touchedFields, setTouchedFields] = useState<{
    handle: boolean
    newPassword: boolean
    confirmPassword: boolean
    newEmail: boolean
  }>({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })

  // Validation results
  const handleValidation = validateHandle(handle)
  const newPasswordValidation = validatePassword(newPassword)
  const confirmPasswordValidation = validatePasswordMatch(newPassword, confirmNewPassword)
  const newEmailValidation = validateEmail(newEmail)

  const markTouched = (field: keyof typeof touchedFields) => {
    setTouchedFields(prev => ({ ...prev, [field]: true }))
  }

  // Check if there are unsaved profile changes
  const hasUnsavedChanges = useCallback(() => {
    if (!initialValuesRef.current) return false
    const initial = initialValuesRef.current
    return (
      handle !== initial.handle ||
      bio !== initial.bio ||
      avatarFile !== null ||
      coverFile !== null ||
      notifyFollow !== initial.notifyFollow ||
      notifyLike !== initial.notifyLike ||
      notifyComment !== initial.notifyComment ||
      notifyMention !== initial.notifyMention ||
      notifyMessage !== initial.notifyMessage ||
      showFollowers !== initial.showFollowers ||
      showFollowing !== initial.showFollowing ||
      dmPermission !== initial.dmPermission ||
      showProBadge !== initial.showProBadge
    )
  }, [handle, bio, avatarFile, coverFile, notifyFollow, notifyLike, notifyComment, notifyMention, notifyMessage, showFollowers, showFollowing, dmPermission, showProBadge])

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  // Handle section from URL
  useEffect(() => {
    const section = searchParams.get('section') as SectionId | null
    if (section && SECTIONS.some(s => s.id === section)) {
      setActiveSection(section)
      // Scroll to section after a short delay for DOM to render
      setTimeout(() => {
        document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    }
  }, [searchParams])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)

      if (!data.user) {
        router.push('/login')
        return
      }

      loadProfile(data.user.id)
    })
  }, [router])

  const loadProfile = async (uid: string) => {
    try {
      setLoading(true)

      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle, bio, avatar_url, cover_url, notify_follow, notify_like, notify_comment, notify_mention, notify_message, show_followers, show_following, dm_permission, show_pro_badge')
        .eq('id', uid)
        .maybeSingle()

      if (userProfile) {
        const profileHandle = userProfile.handle || ''
        const profileBio = userProfile.bio || ''
        const profileAvatarUrl = userProfile.avatar_url || null
        const profileCoverUrl = userProfile.cover_url || null
        const profileNotifyFollow = userProfile.notify_follow !== false
        const profileNotifyLike = userProfile.notify_like !== false
        const profileNotifyComment = userProfile.notify_comment !== false
        const profileNotifyMention = userProfile.notify_mention !== false
        const profileNotifyMessage = userProfile.notify_message !== false
        const profileShowFollowers = userProfile.show_followers !== false
        const profileShowFollowing = userProfile.show_following !== false
        const profileDmPermission = userProfile.dm_permission || 'all'
        const profileShowProBadge = userProfile.show_pro_badge !== false

        setHandle(profileHandle)
        setBio(profileBio)
        setAvatarUrl(profileAvatarUrl)
        setPreviewUrl(profileAvatarUrl)
        setCoverUrl(profileCoverUrl)
        setCoverPreviewUrl(profileCoverUrl)
        setNotifyFollow(profileNotifyFollow)
        setNotifyLike(profileNotifyLike)
        setNotifyComment(profileNotifyComment)
        setNotifyMention(profileNotifyMention)
        setNotifyMessage(profileNotifyMessage)
        setShowFollowers(profileShowFollowers)
        setShowFollowing(profileShowFollowing)
        setDmPermission(profileDmPermission)
        setShowProBadge(profileShowProBadge)

        initialValuesRef.current = {
          handle: profileHandle,
          bio: profileBio,
          avatarUrl: profileAvatarUrl,
          coverUrl: profileCoverUrl,
          notifyFollow: profileNotifyFollow,
          notifyLike: profileNotifyLike,
          notifyComment: profileNotifyComment,
          notifyMention: profileNotifyMention,
          notifyMessage: profileNotifyMessage,
          showFollowers: profileShowFollowers,
          showFollowing: profileShowFollowing,
          dmPermission: profileDmPermission,
          showProBadge: profileShowProBadge,
        }
      }

    } catch (error) {
      uiLogger.error('Error loading profile:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        showToast('图片大小不能超过 5MB', 'error')
        return
      }
      setAvatarFile(file)
      const reader = new FileReader()
      reader.onloadend = () => {
        setPreviewUrl(reader.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        showToast('图片大小不能超过 10MB', 'error')
        return
      }
      setCoverFile(file)
      const reader = new FileReader()
      reader.onloadend = () => {
        setCoverPreviewUrl(reader.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  const uploadFile = async (file: File, bucket: string, userId: string, maxSize: number): Promise<string | null> => {
    try {
      if (file.size > maxSize) {
        showToast(`图片大小不能超过 ${Math.round(maxSize / 1024 / 1024)}MB`, 'error')
        return null
      }

      const fileExt = file.name.split('.').pop()?.toLowerCase()
      if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt || '')) {
        showToast('只支持 JPG、PNG、GIF、WebP 格式', 'error')
        return null
      }

      const fileName = `${userId}-${Date.now()}.${fileExt}`

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(fileName, file, { upsert: true })

      if (uploadError) {
        uiLogger.error(`${bucket} upload error:`, uploadError)
        if (uploadError.message?.includes('Bucket not found')) {
          showToast('存储服务未配置，请联系管理员', 'error')
        } else if (uploadError.message?.includes('security') || uploadError.message?.includes('policy')) {
          showToast('没有上传权限，请联系管理员', 'error')
        } else {
          showToast(`上传失败: ${uploadError.message}`, 'error')
        }
        return null
      }

      const { data } = supabase.storage.from(bucket).getPublicUrl(fileName)
      return data.publicUrl
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      showToast(`上传异常: ${errorMessage}`, 'error')
      return null
    }
  }

  const handleSaveProfile = async () => {
    if (!userId) return

    // Validate handle before saving
    if (handle && !handleValidation.valid) {
      showToast(handleValidation.message, 'error')
      return
    }
    if (handle && handleAvailable === false) {
      showToast('用户名已被占用，请选择其他用户名', 'error')
      return
    }

    setSaving(true)
    try {
      const { data: currentProfile } = await supabase
        .from('user_profiles')
        .select('avatar_url, cover_url')
        .eq('id', userId)
        .maybeSingle()

      let finalAvatarUrl = avatarUrl
      let finalCoverUrl = coverUrl

      if (avatarFile) {
        const uploadedUrl = await uploadFile(avatarFile, 'avatars', userId, 5 * 1024 * 1024)
        if (uploadedUrl) {
          finalAvatarUrl = uploadedUrl
          setAvatarUrl(uploadedUrl)
          setPreviewUrl(uploadedUrl)
        } else {
          if (currentProfile?.avatar_url) {
            finalAvatarUrl = currentProfile.avatar_url
          }
        }
      }

      if (coverFile) {
        const uploadedUrl = await uploadFile(coverFile, 'covers', userId, 10 * 1024 * 1024)
        if (uploadedUrl) {
          finalCoverUrl = uploadedUrl
          setCoverUrl(uploadedUrl)
          setCoverPreviewUrl(uploadedUrl)
        } else {
          if (currentProfile?.cover_url) {
            finalCoverUrl = currentProfile.cover_url
          }
        }
      }

      const { error: saveError } = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: userId,
            handle: handle || null,
            bio: bio || null,
            avatar_url: finalAvatarUrl || null,
            cover_url: finalCoverUrl || null,
            notify_follow: notifyFollow,
            notify_like: notifyLike,
            notify_comment: notifyComment,
            notify_mention: notifyMention,
            notify_message: notifyMessage,
            show_followers: showFollowers,
            show_following: showFollowing,
            dm_permission: dmPermission,
            show_pro_badge: showProBadge,
          },
          { onConflict: 'id' }
        )

      if (saveError) {
        uiLogger.error('Error saving profile:', JSON.stringify(saveError, null, 2))
        if (saveError.code === '23505' || saveError.message?.includes('unique') || saveError.message?.includes('duplicate')) {
          showToast('用户名已被使用，请选择其他用户名', 'error')
        } else {
          showToast(`保存失败: ${saveError.message || '请重试'}`, 'error')
        }
        return
      }

      // Update initial values after successful save
      initialValuesRef.current = {
        handle,
        bio,
        avatarUrl: finalAvatarUrl,
        coverUrl: finalCoverUrl,
        notifyFollow,
        notifyLike,
        notifyComment,
        notifyMention,
        notifyMessage,
        showFollowers,
        showFollowing,
        dmPermission,
        showProBadge,
      }
      setAvatarFile(null)
      setCoverFile(null)

      showToast('所有设置已保存', 'success')
    } catch (error) {
      uiLogger.error('Error saving:', error)
      showToast('保存失败，请重试', 'error')
    } finally {
      setSaving(false)
    }
  }

  // Reset countdown timer
  useEffect(() => {
    if (resetCountdown > 0) {
      const timer = setTimeout(() => setResetCountdown(resetCountdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [resetCountdown])

  const handleSendResetCode = async () => {
    if (!email) {
      showToast('无法获取用户邮箱', 'error')
      return
    }

    setSendingResetCode(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })

      if (error) {
        showToast(error.message, 'error')
        return
      }

      setResetCodeSent(true)
      setResetCountdown(60)
      showToast('密码重置邮件已发送，请查收邮箱', 'success')
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '发送失败'
      showToast(msg, 'error')
    } finally {
      setSendingResetCode(false)
    }
  }

  const handleChangePassword = async () => {
    if (!currentPassword) {
      showToast('请输入当前密码', 'warning')
      return
    }
    if (!newPassword || !newPasswordValidation.valid) {
      showToast('请输入有效的新密码（至少6位）', 'warning')
      return
    }
    if (!confirmPasswordValidation.valid) {
      showToast('两次输入的密码不一致', 'warning')
      return
    }

    setSavingPassword(true)
    try {
      if (!email) {
        showToast('无法获取用户邮箱', 'error')
        return
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      })

      if (signInError) {
        showToast('当前密码不正确', 'error')
        return
      }

      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      })

      if (error) {
        showToast(error.message, 'error')
        return
      }

      showToast('密码修改成功', 'success')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
      setTouchedFields(prev => ({ ...prev, newPassword: false, confirmPassword: false }))
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '修改失败'
      showToast(msg, 'error')
    } finally {
      setSavingPassword(false)
    }
  }

  const handleChangeEmail = async () => {
    if (!newEmail || !newEmailValidation.valid) {
      showToast('请输入有效的邮箱地址', 'warning')
      return
    }

    setSavingEmail(true)
    try {
      const { error } = await supabase.auth.updateUser({
        email: newEmail,
      })

      if (error) {
        showToast(error.message, 'error')
        return
      }

      showToast('验证邮件已发送到新邮箱，请查收确认', 'success')
      setNewEmail('')
      setTouchedFields(prev => ({ ...prev, newEmail: false }))
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '修改失败'
      showToast(msg, 'error')
    } finally {
      setSavingEmail(false)
    }
  }

  // 保存通知偏好
  const handleSaveNotifications = async () => {
    if (!userId) return
    setSavingNotifications(true)

    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({
          notify_follow: notifyFollow,
          notify_like: notifyLike,
          notify_comment: notifyComment,
          notify_mention: notifyMention,
          notify_message: notifyMessage,
        })
        .eq('id', userId)

      if (error) {
        showToast('保存失败，请重试', 'error')
        return
      }

      showToast('通知偏好已保存', 'success')
    } catch {
      showToast('保存失败', 'error')
    } finally {
      setSavingNotifications(false)
    }
  }

  const handleLogout = async () => {
    const confirmed = await showConfirm('退出登录', '确定要退出当前账号吗？')
    if (!confirmed) return

    try {
      await supabase.auth.signOut()
      router.push('/')
    } catch {
      showToast('退出失败，请重试', 'error')
    }
  }

  // Scroll-based active section detection
  useEffect(() => {
    const handleScroll = () => {
      const sections = SECTIONS.map(s => document.getElementById(s.id))
      const scrollTop = window.scrollY + 120

      for (let i = sections.length - 1; i >= 0; i--) {
        const section = sections[i]
        if (section && section.offsetTop <= scrollTop) {
          setActiveSection(SECTIONS[i].id)
          break
        }
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // Show auth-required state if not logged in (after initial check)
  if (!loading && !userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{
          maxWidth: 400,
          margin: '0 auto',
          padding: tokens.spacing[8],
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[4],
        }}>
          <Box style={{
            width: 64,
            height: 64,
            borderRadius: tokens.radius.full,
            background: `${tokens.colors.accent.primary}15`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: tokens.spacing[2],
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </Box>
          <Text size="xl" weight="bold">请先登录</Text>
          <Text size="sm" color="secondary" style={{ lineHeight: 1.6 }}>
            您需要登录才能访问设置页面
          </Text>
          <Button
            variant="primary"
            onClick={() => router.push('/login?redirect=/settings')}
            style={{ marginTop: tokens.spacing[2] }}
          >
            前往登录
          </Button>
        </Box>
      </Box>
    )
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{
          maxWidth: 800,
          margin: '0 auto',
          padding: tokens.spacing[6],
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[3],
        }}>
          <Box style={{
            width: 32,
            height: 32,
            border: `3px solid ${tokens.colors.border.primary}`,
            borderTopColor: tokens.colors.accent.primary,
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
          <Text size="lg" color="secondary">加载中...</Text>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], display: 'flex', gap: tokens.spacing[8] }}>
        {/* Sidebar Navigation - Desktop only */}
        <Box
          className="settings-sidebar"
          style={{
            width: 180,
            flexShrink: 0,
            position: 'sticky',
            top: 80,
            alignSelf: 'flex-start',
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[1],
          }}
        >
          {SECTIONS.map(section => (
            <button
              key={section.id}
              onClick={() => {
                setActiveSection(section.id)
                document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: activeSection === section.id ? tokens.colors.bg.tertiary : 'transparent',
                color: activeSection === section.id ? tokens.colors.text.primary : tokens.colors.text.secondary,
                fontWeight: activeSection === section.id ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                fontSize: tokens.typography.fontSize.sm,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
                width: '100%',
              }}
            >
              <span style={{ fontSize: '14px' }}>{section.icon}</span>
              {section.label}
            </button>
          ))}
        </Box>

        {/* Main Content */}
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            设置
          </Text>

          {/* Mobile Section Navigation - horizontal scroll tabs */}
          <Box
            className="settings-mobile-nav"
            style={{
              display: 'none',
              gap: tokens.spacing[2],
              marginBottom: tokens.spacing[5],
              overflowX: 'auto',
              paddingBottom: tokens.spacing[2],
              WebkitOverflowScrolling: 'touch',
              msOverflowStyle: 'none',
              scrollbarWidth: 'none',
            }}
          >
            {SECTIONS.map(section => (
              <button
                key={section.id}
                onClick={() => {
                  setActiveSection(section.id)
                  document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[1],
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.full,
                  border: `1px solid ${activeSection === section.id ? tokens.colors.accent.primary + '60' : tokens.colors.border.primary}`,
                  background: activeSection === section.id ? `${tokens.colors.accent.primary}15` : tokens.colors.bg.secondary,
                  color: activeSection === section.id ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: activeSection === section.id ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  transition: 'all 0.15s ease',
                }}
              >
                <span style={{ fontSize: '12px' }}>{section.icon}</span>
                {section.label}
              </button>
            ))}
          </Box>

          {/* ===== Profile Section ===== */}
          <SectionCard id="profile" title="个人资料" description="这些信息将在你的个人主页上展示给其他用户">
            {/* Avatar */}
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginBottom: tokens.spacing[5] }}>
              {userId ? (
                <Avatar
                  userId={userId}
                  name={handle || email}
                  avatarUrl={previewUrl}
                  size={80}
                  style={{
                    borderRadius: tokens.radius.xl,
                    border: `2px solid ${tokens.colors.border.primary}`,
                  }}
                />
              ) : (
                <Box
                  style={{
                    width: 80,
                    height: 80,
                    borderRadius: tokens.radius.xl,
                    background: tokens.colors.bg.tertiary,
                    border: `2px solid ${tokens.colors.border.primary}`,
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Text size="2xl" weight="black" style={{ color: tokens.colors.text.secondary }}>
                    {(handle?.[0] || email?.[0] || 'U').toUpperCase()}
                  </Text>
                </Box>
              )}

              <Box>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={handleAvatarChange}
                  style={{ display: 'none' }}
                  id="avatar-input"
                />
                <label
                  htmlFor="avatar-input"
                  style={{
                    display: 'inline-block',
                    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    cursor: 'pointer',
                    fontWeight: tokens.typography.fontWeight.bold,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
                  更换头像
                </label>
                <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1], display: 'block' }}>
                  JPG、PNG、GIF、WebP，最大 5MB
                </Text>
              </Box>
            </Box>

            {/* Cover Image */}
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                背景图片
              </Text>
              <Box
                style={{
                  width: '100%',
                  height: 120,
                  borderRadius: tokens.radius.lg,
                  background: coverPreviewUrl
                    ? `url(${coverPreviewUrl}) center/cover no-repeat`
                    : `linear-gradient(135deg, ${tokens.colors.bg.tertiary} 0%, ${tokens.colors.bg.secondary} 100%)`,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: tokens.spacing[2],
                }}
              >
                {!coverPreviewUrl && (
                  <Text size="sm" color="tertiary">暂无背景图片</Text>
                )}
              </Box>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={handleCoverChange}
                  style={{ display: 'none' }}
                  id="cover-input"
                />
                <label
                  htmlFor="cover-input"
                  style={{
                    display: 'inline-block',
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    cursor: 'pointer',
                    fontWeight: tokens.typography.fontWeight.bold,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
                  更换背景
                </label>
                {coverPreviewUrl && (
                  <button
                    onClick={() => {
                      setCoverFile(null)
                      setCoverPreviewUrl(null)
                      setCoverUrl(null)
                    }}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.accent.error}40`,
                      background: 'transparent',
                      color: tokens.colors.accent.error,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.sm,
                    }}
                  >
                    移除
                  </button>
                )}
                <Text size="xs" color="tertiary">
                  最大 10MB，建议 1200×400
                </Text>
              </Box>
            </Box>

            {/* Handle */}
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                用户名
              </Text>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value.slice(0, MAX_HANDLE_LENGTH))}
                onBlur={() => markTouched('handle')}
                placeholder="设置你的用户名"
                style={getInputStyle(touchedFields.handle && !handleValidation.valid)}
              />
              <Box style={{ display: 'flex', justifyContent: 'space-between', marginTop: tokens.spacing[1] }}>
                <Box>
                  {touchedFields.handle && handle && !handleValidation.valid && (
                    <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                      {handleValidation.message}
                    </Text>
                  )}
                  {touchedFields.handle && handle && handleValidation.valid && checkingHandle && (
                    <Text size="xs" color="tertiary">
                      检查中...
                    </Text>
                  )}
                  {touchedFields.handle && handle && handleValidation.valid && !checkingHandle && handleAvailable === true && (
                    <Text size="xs" style={{ color: tokens.colors.accent.success }}>
                      用户名可用
                    </Text>
                  )}
                  {touchedFields.handle && handle && handleValidation.valid && !checkingHandle && handleAvailable === false && (
                    <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                      用户名已被占用
                    </Text>
                  )}
                </Box>
                <Text size="xs" color="tertiary">
                  {handle.length}/{MAX_HANDLE_LENGTH}
                </Text>
              </Box>
            </Box>

            {/* Bio */}
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                个人简介
              </Text>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value.slice(0, MAX_BIO_LENGTH))}
                placeholder="介绍一下自己..."
                rows={4}
                style={{
                  ...getInputStyle(),
                  resize: 'vertical',
                  minHeight: '80px',
                }}
              />
              <Box style={{ display: 'flex', justifyContent: 'flex-end', marginTop: tokens.spacing[1] }}>
                <Text
                  size="xs"
                  style={{
                    color: bio.length > MAX_BIO_LENGTH * 0.9
                      ? tokens.colors.accent.warning
                      : tokens.colors.text.tertiary
                  }}
                >
                  {bio.length}/{MAX_BIO_LENGTH}
                </Text>
              </Box>
            </Box>
          </SectionCard>

          {/* ===== Security Section ===== */}
          <SectionCard id="security" title="账号安全" description="管理你的登录凭证和账号安全设置">
            {/* Current Email Display */}
            <Box style={{ marginBottom: tokens.spacing[5], padding: tokens.spacing[3], borderRadius: tokens.radius.md, background: tokens.colors.bg.primary }}>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>当前登录邮箱</Text>
              <Text size="sm" weight="bold">{email}</Text>
            </Box>

            {/* Change Email */}
            <Box style={{ marginBottom: tokens.spacing[6] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                修改邮箱
              </Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onBlur={() => markTouched('newEmail')}
                  placeholder="输入新邮箱地址"
                  style={{ ...getInputStyle(touchedFields.newEmail && !newEmailValidation.valid), flex: 1 }}
                />
                <Button
                  variant="secondary"
                  onClick={handleChangeEmail}
                  disabled={savingEmail || !newEmail || !newEmailValidation.valid}
                >
                  {savingEmail ? '发送中...' : '验证'}
                </Button>
              </Box>
              {touchedFields.newEmail && newEmail && !newEmailValidation.valid && (
                <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                  {newEmailValidation.message}
                </Text>
              )}
              <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                修改后需要在新邮箱中确认验证链接
              </Text>
            </Box>

            {/* Change Password */}
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                修改密码
              </Text>

              {/* Mode Selector */}
              <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
                <button
                  onClick={() => setPasswordResetMode('password')}
                  style={{
                    flex: 1,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${passwordResetMode === 'password' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                    background: passwordResetMode === 'password' ? `${tokens.colors.accent.primary}15` : 'transparent',
                    color: passwordResetMode === 'password' ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  用当前密码修改
                </button>
                <button
                  onClick={() => setPasswordResetMode('code')}
                  style={{
                    flex: 1,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${passwordResetMode === 'code' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                    background: passwordResetMode === 'code' ? `${tokens.colors.accent.primary}15` : 'transparent',
                    color: passwordResetMode === 'code' ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  通过邮箱重置
                </button>
              </Box>

              {passwordResetMode === 'password' ? (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="当前密码"
                    style={getInputStyle()}
                  />
                  <Box>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      onBlur={() => markTouched('newPassword')}
                      placeholder="新密码（至少6位）"
                      style={getInputStyle(touchedFields.newPassword && !newPasswordValidation.valid)}
                    />
                    {touchedFields.newPassword && newPassword && !newPasswordValidation.valid && (
                      <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                        {newPasswordValidation.message}
                      </Text>
                    )}
                  </Box>
                  <Box>
                    <input
                      type="password"
                      value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)}
                      onBlur={() => markTouched('confirmPassword')}
                      placeholder="确认新密码"
                      style={getInputStyle(touchedFields.confirmPassword && !confirmPasswordValidation.valid)}
                    />
                    {touchedFields.confirmPassword && confirmNewPassword && !confirmPasswordValidation.valid && (
                      <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                        {confirmPasswordValidation.message}
                      </Text>
                    )}
                    {touchedFields.confirmPassword && confirmNewPassword && confirmPasswordValidation.valid && (
                      <Text size="xs" style={{ color: tokens.colors.accent.success, marginTop: tokens.spacing[1] }}>
                        密码匹配
                      </Text>
                    )}
                  </Box>
                  <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      variant="secondary"
                      onClick={handleChangePassword}
                      disabled={savingPassword || !currentPassword || !newPassword || !newPasswordValidation.valid || !confirmPasswordValidation.valid}
                    >
                      {savingPassword ? '修改中...' : '修改密码'}
                    </Button>
                  </Box>
                </Box>
              ) : (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                  <Text size="sm" color="secondary">
                    将发送密码重置链接到：{email}
                  </Text>
                  <Text size="xs" color="tertiary">
                    点击邮件中的链接即可设置新密码，有效期 1 小时
                  </Text>
                  <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      variant="secondary"
                      onClick={handleSendResetCode}
                      disabled={sendingResetCode || resetCountdown > 0}
                    >
                      {sendingResetCode
                        ? '发送中...'
                        : resetCountdown > 0
                          ? `${resetCountdown}s 后可重发`
                          : resetCodeSent
                            ? '重新发送'
                            : '发送重置邮件'}
                    </Button>
                  </Box>
                  {resetCodeSent && (
                    <Box
                      style={{
                        padding: tokens.spacing[3],
                        borderRadius: tokens.radius.md,
                        background: `${tokens.colors.accent.success}10`,
                        border: `1px solid ${tokens.colors.accent.success}30`,
                      }}
                    >
                      <Text size="sm" style={{ color: tokens.colors.accent.success }}>
                        重置邮件已发送，请查收并点击链接
                      </Text>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          </SectionCard>

          {/* ===== Exchange Connections Section ===== */}
          <Box
            id="exchanges"
            style={{
              marginBottom: tokens.spacing[6],
              padding: tokens.spacing[6],
              borderRadius: tokens.radius.xl,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            {userId && <ExchangeConnectionManager userId={userId} />}
          </Box>

          {/* ===== Notification Preferences Section ===== */}
          <SectionCard id="notifications" title="通知偏好" description="选择你想接收的通知类型">
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
              {[
                { key: 'follow', label: '新粉丝通知', desc: '有人关注你时', value: notifyFollow, setter: setNotifyFollow },
                { key: 'like', label: '点赞通知', desc: '有人点赞你的帖子时', value: notifyLike, setter: setNotifyLike },
                { key: 'comment', label: '评论通知', desc: '有人评论你的帖子时', value: notifyComment, setter: setNotifyComment },
                { key: 'mention', label: '@提及通知', desc: '有人在帖子中提及你时', value: notifyMention, setter: setNotifyMention },
                { key: 'message', label: '私信通知', desc: '收到新私信时', value: notifyMessage, setter: setNotifyMessage },
              ].map(item => (
                <Box
                  key={item.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    transition: 'background 0.15s ease',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.primary }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <Box>
                    <Text size="sm" weight="medium">{item.label}</Text>
                    <Text size="xs" color="tertiary">{item.desc}</Text>
                  </Box>
                  <ToggleSwitch
                    checked={item.value}
                    onChange={(v) => item.setter(v)}
                  />
                </Box>
              ))}
            </Box>
          </SectionCard>

          {/* ===== Privacy Settings Section ===== */}
          <SectionCard id="privacy" title="隐私设置" description="控制谁能看到你的信息">
            {/* Follow lists visibility */}
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                关注列表可见性
              </Text>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                关闭后，其他用户将无法查看对应列表
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={showFollowing}
                    onChange={(e) => setShowFollowing(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                  />
                  <Text size="sm">公开我的关注列表</Text>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={showFollowers}
                    onChange={(e) => setShowFollowers(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                  />
                  <Text size="sm">公开我的粉丝列表</Text>
                </label>
              </Box>
            </Box>

            {/* Pro Badge */}
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                Pro 徽章
              </Text>
              <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showProBadge}
                  onChange={(e) => setShowProBadge(e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                />
                <Box>
                  <Text size="sm">在主页显示 Pro 徽章</Text>
                  <Text size="xs" color="tertiary">关闭后其他用户看不到你的会员标识</Text>
                </Box>
              </label>
            </Box>

            {/* DM Permission */}
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                谁可以给我发私信
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {([
                  { value: 'all' as const, label: '所有人', desc: '任何人都可以给你发私信' },
                  { value: 'mutual' as const, label: '互相关注的人', desc: '非互关者最多发3条，你回复后对方可继续' },
                  { value: 'none' as const, label: '不接收私信', desc: '关闭所有私信功能' },
                ]).map(option => (
                  <label
                    key={option.value}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: tokens.spacing[3],
                      cursor: 'pointer',
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${dmPermission === option.value ? tokens.colors.accent.primary + '40' : 'transparent'}`,
                      background: dmPermission === option.value ? `${tokens.colors.accent.primary}08` : 'transparent',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <input
                      type="radio"
                      name="dmPermission"
                      checked={dmPermission === option.value}
                      onChange={() => setDmPermission(option.value)}
                      style={{ width: 18, height: 18, accentColor: '#8b6fa8', marginTop: 2 }}
                    />
                    <Box>
                      <Text size="sm" weight="medium">{option.label}</Text>
                      <Text size="xs" color="tertiary">{option.desc}</Text>
                    </Box>
                  </label>
                ))}
              </Box>
            </Box>
          </SectionCard>

          {/* ===== Account Management (Danger Zone) ===== */}
          <SectionCard id="account" title="账号管理" variant="danger">
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Box>
                  <Text size="sm" weight="medium">退出登录</Text>
                  <Text size="xs" color="tertiary">退出当前账号，需要重新登录才能访问设置</Text>
                </Box>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleLogout}
                  style={{
                    color: tokens.colors.accent.error,
                    borderColor: tokens.colors.accent.error + '40',
                  }}
                >
                  退出登录
                </Button>
              </Box>
            </Box>
          </SectionCard>

          {/* ===== Floating Save Bar ===== */}
          {hasUnsavedChanges() && (
            <Box
              style={{
                position: 'sticky',
                bottom: tokens.spacing[4],
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.xl,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.accent.warning}40`,
                boxShadow: tokens.shadow.lg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                zIndex: 50,
              }}
            >
              <Text size="sm" style={{ color: tokens.colors.accent.warning }}>
                有未保存的更改
              </Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    const confirmed = await showConfirm('放弃更改', '确定要放弃所有未保存的更改吗？')
                    if (confirmed && userId) {
                      setTouchedFields({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })
                      setHandleAvailable(null)
                      setAvatarFile(null)
                      setCoverFile(null)
                      loadProfile(userId)
                    }
                  }}
                  disabled={saving}
                >
                  放弃
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveProfile}
                  disabled={saving}
                >
                  {saving ? '保存中...' : '保存所有更改'}
                </Button>
              </Box>
            </Box>
          )}

          {/* Bottom spacer */}
          <Box style={{ height: tokens.spacing[12] }} />
        </Box>
      </Box>

      {/* Responsive styles */}
      <style>{`
        @media (max-width: 768px) {
          .settings-sidebar {
            display: none !important;
          }
          .settings-mobile-nav {
            display: flex !important;
          }
          .settings-mobile-nav::-webkit-scrollbar {
            display: none;
          }
        }
      `}</style>
    </Box>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {[1, 2, 3].map(i => (
              <Box
                key={i}
                style={{
                  height: 120,
                  borderRadius: tokens.radius.xl,
                  background: tokens.colors.bg.secondary,
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
            ))}
          </Box>
        </Box>
      </Box>
    }>
      <SettingsContent />
    </Suspense>
  )
}
