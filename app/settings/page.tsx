'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import ToggleSwitch from '@/app/components/ui/ToggleSwitch'
import ExchangeConnectionManager from '@/app/components/exchange/ExchangeConnection'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useAppSettings, type ThemeMode } from '@/lib/hooks/useSettings'
import { uiLogger } from '@/lib/utils/logger'

// ============================================
// Validation Functions
// ============================================

function validateHandle(handle: string): { valid: boolean; message: string } {
  if (!handle) return { valid: true, message: '' }
  if (handle.length < 1) {
    return { valid: false, message: '用户名至少需要1个字符' }
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

// ============================================
// Section Navigation Config
// ============================================

type SectionId = 'profile' | 'account' | 'notifications' | 'privacy' | 'display' | 'social' | 'danger'

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'profile', label: '个人资料', icon: '👤' },
  { id: 'social', label: '社交链接', icon: '🔗' },
  { id: 'account', label: '账号安全', icon: '🔒' },
  { id: 'notifications', label: '通知偏好', icon: '🔔' },
  { id: 'privacy', label: '隐私设置', icon: '🛡️' },
  { id: 'display', label: '显示偏好', icon: '🎨' },
  { id: 'danger', label: '账号管理', icon: '⚠️' },
]

// ============================================
// Reusable Setting Row
// ============================================

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacing[4], padding: `${tokens.spacing[3]} 0`, borderBottom: `1px solid ${tokens.colors.border.primary}20` }}>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" weight="medium" style={{ marginBottom: description ? 2 : 0 }}>{label}</Text>
        {description && <Text size="xs" color="tertiary">{description}</Text>}
      </Box>
      <Box style={{ flexShrink: 0 }}>{children}</Box>
    </Box>
  )
}

// ============================================
// Input styles helper
// ============================================

function inputStyle(hasError = false): React.CSSProperties {
  return {
    width: '100%',
    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
    borderRadius: tokens.radius.lg,
    border: `1px solid ${hasError ? '#ff7c7c' : tokens.colors.border.primary}`,
    background: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.base,
    fontFamily: tokens.typography.fontFamily.sans.join(', '),
    outline: 'none',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  }
}

// ============================================
// Main Settings Page
// ============================================

export default function SettingsPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { settings: appSettings, updateSettings: updateAppSettings } = useAppSettings()

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

  // Social links
  const [socialTwitter, setSocialTwitter] = useState('')
  const [socialTelegram, setSocialTelegram] = useState('')
  const [socialDiscord, setSocialDiscord] = useState('')
  const [socialGithub, setSocialGithub] = useState('')
  const [socialWebsite, setSocialWebsite] = useState('')

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
    socialTwitter: string
    socialTelegram: string
    socialDiscord: string
    socialGithub: string
    socialWebsite: string
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

  // Privacy settings
  const [showFollowers, setShowFollowers] = useState(true)
  const [showFollowing, setShowFollowing] = useState(true)
  const [dmPermission, setDmPermission] = useState<'all' | 'mutual' | 'none'>('all')
  const [showProBadge, setShowProBadge] = useState(true)

  // Validation states
  const [touchedFields, setTouchedFields] = useState<{
    handle: boolean
    newPassword: boolean
    confirmPassword: boolean
    newEmail: boolean
  }>({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })

  const handleValidation = validateHandle(handle)
  const newPasswordValidation = validatePassword(newPassword)
  const confirmPasswordValidation = validatePasswordMatch(newPassword, confirmNewPassword)
  const newEmailValidation = validateEmail(newEmail)

  const markTouched = (field: keyof typeof touchedFields) => {
    setTouchedFields(prev => ({ ...prev, [field]: true }))
  }

  const scrollToSection = (id: SectionId) => {
    setActiveSection(id)
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Check for unsaved changes
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
      showProBadge !== initial.showProBadge ||
      socialTwitter !== initial.socialTwitter ||
      socialTelegram !== initial.socialTelegram ||
      socialDiscord !== initial.socialDiscord ||
      socialGithub !== initial.socialGithub ||
      socialWebsite !== initial.socialWebsite
    )
  }, [handle, bio, avatarFile, coverFile, notifyFollow, notifyLike, notifyComment, notifyMention, notifyMessage, showFollowers, showFollowing, dmPermission, showProBadge, socialTwitter, socialTelegram, socialDiscord, socialGithub, socialWebsite])

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
        .select('handle, bio, avatar_url, cover_url, notify_follow, notify_like, notify_comment, notify_mention, notify_message, show_followers, show_following, dm_permission, show_pro_badge, social_twitter, social_telegram, social_discord, social_github, social_website')
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
        const profileSocialTwitter = (userProfile as Record<string, unknown>).social_twitter as string || ''
        const profileSocialTelegram = (userProfile as Record<string, unknown>).social_telegram as string || ''
        const profileSocialDiscord = (userProfile as Record<string, unknown>).social_discord as string || ''
        const profileSocialGithub = (userProfile as Record<string, unknown>).social_github as string || ''
        const profileSocialWebsite = (userProfile as Record<string, unknown>).social_website as string || ''

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
        setSocialTwitter(profileSocialTwitter)
        setSocialTelegram(profileSocialTelegram)
        setSocialDiscord(profileSocialDiscord)
        setSocialGithub(profileSocialGithub)
        setSocialWebsite(profileSocialWebsite)

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
          socialTwitter: profileSocialTwitter,
          socialTelegram: profileSocialTelegram,
          socialDiscord: profileSocialDiscord,
          socialGithub: profileSocialGithub,
          socialWebsite: profileSocialWebsite,
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
      reader.onloadend = () => setPreviewUrl(reader.result as string)
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
      reader.onloadend = () => setCoverPreviewUrl(reader.result as string)
      reader.readAsDataURL(file)
    }
  }

  const uploadFile = async (file: File, bucket: string, userId: string, maxSize: number): Promise<string | null> => {
    try {
      if (file.size > maxSize) {
        showToast(`文件大小超过限制`, 'error')
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

  const handleSave = async () => {
    if (!userId) return
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
        } else if (currentProfile?.avatar_url) {
          finalAvatarUrl = currentProfile.avatar_url
        }
      }

      if (coverFile) {
        const uploadedUrl = await uploadFile(coverFile, 'covers', userId, 10 * 1024 * 1024)
        if (uploadedUrl) {
          finalCoverUrl = uploadedUrl
          setCoverUrl(uploadedUrl)
          setCoverPreviewUrl(uploadedUrl)
        } else if (currentProfile?.cover_url) {
          finalCoverUrl = currentProfile.cover_url
        }
      }

      const { error: userProfilesError } = await supabase
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
            social_twitter: socialTwitter || null,
            social_telegram: socialTelegram || null,
            social_discord: socialDiscord || null,
            social_github: socialGithub || null,
            social_website: socialWebsite || null,
          },
          { onConflict: 'id' }
        )

      if (userProfilesError) {
        uiLogger.error('Error saving profile:', JSON.stringify(userProfilesError, null, 2))
        if (userProfilesError.code === '23505' || userProfilesError.message?.includes('unique') || userProfilesError.message?.includes('duplicate')) {
          showToast('用户名已被使用，请选择其他用户名', 'error')
        } else {
          showToast(`保存失败: ${userProfilesError.message || '请重试'}`, 'error')
        }
        return
      }

      initialValuesRef.current = {
        handle, bio,
        avatarUrl: finalAvatarUrl, coverUrl: finalCoverUrl,
        notifyFollow, notifyLike, notifyComment, notifyMention, notifyMessage,
        showFollowers, showFollowing, dmPermission, showProBadge,
        socialTwitter, socialTelegram, socialDiscord, socialGithub, socialWebsite,
      }
      setAvatarFile(null)
      setCoverFile(null)
      showToast('保存成功！', 'success')
      router.push(`/u/${handle || userId}`)
    } catch (error) {
      uiLogger.error('Error saving:', error)
      showToast('保存失败，请重试', 'error')
    } finally {
      setSaving(false)
    }
  }

  // Reset countdown
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
    if (!currentPassword) { showToast('请输入当前密码', 'warning'); return }
    if (!newPassword || newPassword.length < 6) { showToast('密码至少6位', 'warning'); return }
    if (newPassword !== confirmNewPassword) { showToast('两次输入的密码不一致', 'warning'); return }

    setSavingPassword(true)
    try {
      if (!email) { showToast('无法获取用户邮箱', 'error'); return }
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: currentPassword })
      if (signInError) { showToast('当前密码不正确', 'error'); return }
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) { showToast(error.message, 'error'); return }
      showToast('密码修改成功！', 'success')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '修改失败'
      showToast(msg, 'error')
    } finally {
      setSavingPassword(false)
    }
  }

  const handleChangeEmail = async () => {
    if (!newEmail || !newEmailValidation.valid) { showToast('请输入有效的邮箱地址', 'warning'); return }
    setSavingEmail(true)
    try {
      const { error } = await supabase.auth.updateUser({ email: newEmail })
      if (error) { showToast(error.message, 'error'); return }
      showToast('验证邮件已发送到新邮箱，请查收确认', 'success')
      setNewEmail('')
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '修改失败'
      showToast(msg, 'error')
    } finally {
      setSavingEmail(false)
    }
  }

  const handleDeleteAccount = async () => {
    const confirmed = await showConfirm(
      '删除账号',
      '此操作不可逆！删除账号后，您的所有数据（帖子、评论、关注等）将永久删除。确定要继续吗？'
    )
    if (!confirmed) return

    const doubleConfirm = await showConfirm(
      '最终确认',
      '请再次确认：您确定要永久删除此账号吗？'
    )
    if (!doubleConfirm) return

    showToast('账号删除功能需要管理员处理，请联系客服', 'info')
  }

  const handleLogout = async () => {
    const confirmed = await showConfirm('退出登录', '确定要退出登录吗？')
    if (!confirmed) return
    await supabase.auth.signOut()
    router.push('/')
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1000, margin: '0 auto', padding: tokens.spacing[6], display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 400 }}>
          <Box style={{ textAlign: 'center' }}>
            <Box className="spinner-sm" style={{ width: 32, height: 32, margin: '0 auto 16px', borderColor: `${tokens.colors.border.primary}`, borderTopColor: tokens.colors.accent.primary }} />
            <Text size="sm" color="tertiary">加载设置中...</Text>
          </Box>
        </Box>
      </Box>
    )
  }

  // ============================================
  // Glass card style helper
  // ============================================
  const glassCardStyle: React.CSSProperties = {
    background: tokens.glass.bg.secondary,
    backdropFilter: tokens.glass.blur.lg,
    WebkitBackdropFilter: tokens.glass.blur.lg,
    border: tokens.glass.border.light,
    borderRadius: tokens.radius.xl,
    padding: tokens.spacing[6],
    marginBottom: tokens.spacing[5],
  }

  const sectionTitleStyle: React.CSSProperties = {
    marginBottom: tokens.spacing[5],
    paddingBottom: tokens.spacing[3],
    borderBottom: `1px solid ${tokens.colors.border.primary}40`,
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary, position: 'relative' }}>
      {/* Background mesh */}
      <Box style={{ position: 'fixed', inset: 0, background: tokens.gradient.mesh, opacity: 0.3, pointerEvents: 'none', zIndex: 0 }} />

      <TopNav email={email} />

      <Box style={{ maxWidth: 1100, margin: '0 auto', padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`, position: 'relative', zIndex: 1 }}>
        {/* Page Title */}
        <Box style={{ marginBottom: tokens.spacing[6], display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
          <button
            onClick={async () => {
              if (hasUnsavedChanges()) {
                const confirmed = await showConfirm('放弃更改', '您有未保存的更改，确定要离开吗？')
                if (!confirmed) return
              }
              router.back()
            }}
            style={{ background: 'none', border: 'none', color: tokens.colors.text.secondary, cursor: 'pointer', fontSize: tokens.typography.fontSize.xl, padding: tokens.spacing[2] }}
          >
            ←
          </button>
          <Text size="2xl" weight="black" className="gradient-text">设置</Text>
        </Box>

        <Box style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: tokens.spacing[6], alignItems: 'start' }}>
          {/* Sidebar Navigation */}
          <Box
            style={{
              position: 'sticky',
              top: 80,
              ...glassCardStyle,
              padding: tokens.spacing[3],
              marginBottom: 0,
            }}
            className="settings-sidebar"
          >
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => scrollToSection(section.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                  width: '100%',
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.lg,
                  border: 'none',
                  background: activeSection === section.id
                    ? `${tokens.colors.accent.primary}20`
                    : 'transparent',
                  color: activeSection === section.id
                    ? tokens.colors.accent.primary
                    : tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: activeSection === section.id
                    ? tokens.typography.fontWeight.bold
                    : tokens.typography.fontWeight.medium,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  textAlign: 'left',
                  marginBottom: 2,
                }}
              >
                <span style={{ fontSize: '14px', width: 20, textAlign: 'center' }}>{section.icon}</span>
                {section.label}
              </button>
            ))}
          </Box>

          {/* Main Content */}
          <Box style={{ minWidth: 0 }}>
            {/* ====== PROFILE SECTION ====== */}
            <div id="section-profile" style={glassCardStyle}>
              <Box style={sectionTitleStyle}>
                <Text size="lg" weight="black">个人资料</Text>
                <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>设置您的公开个人信息</Text>
              </Box>

              {/* Avatar + Cover Preview */}
              <Box style={{ marginBottom: tokens.spacing[5] }}>
                {/* Cover preview */}
                <Box
                  style={{
                    width: '100%',
                    height: 120,
                    borderRadius: tokens.radius.lg,
                    background: coverPreviewUrl
                      ? `url(${coverPreviewUrl}) center/cover no-repeat`
                      : `linear-gradient(135deg, ${tokens.colors.bg.tertiary} 0%, ${tokens.colors.accent.primary}15 100%)`,
                    position: 'relative',
                    overflow: 'hidden',
                    border: `1px solid ${tokens.colors.border.primary}40`,
                  }}
                >
                  <input type="file" accept="image/*" onChange={handleCoverChange} style={{ display: 'none' }} id="cover-input" />
                  <label
                    htmlFor="cover-input"
                    style={{
                      position: 'absolute',
                      bottom: tokens.spacing[2],
                      right: tokens.spacing[2],
                      padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      background: 'rgba(0,0,0,0.6)',
                      color: '#fff',
                      fontSize: tokens.typography.fontSize.xs,
                      cursor: 'pointer',
                      backdropFilter: 'blur(4px)',
                    }}
                  >
                    更换背景
                  </label>
                  {coverPreviewUrl && (
                    <button
                      onClick={() => { setCoverFile(null); setCoverPreviewUrl(null); setCoverUrl(null) }}
                      style={{
                        position: 'absolute',
                        top: tokens.spacing[2],
                        right: tokens.spacing[2],
                        width: 24,
                        height: 24,
                        borderRadius: '50%',
                        background: 'rgba(239,68,68,0.8)',
                        color: '#fff',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      ×
                    </button>
                  )}
                </Box>

                {/* Avatar overlay */}
                <Box style={{ display: 'flex', alignItems: 'flex-end', gap: tokens.spacing[4], marginTop: -32, paddingLeft: tokens.spacing[4] }}>
                  <Box style={{ position: 'relative' }}>
                    {userId ? (
                      <Avatar
                        userId={userId}
                        name={handle || email}
                        avatarUrl={previewUrl}
                        size={80}
                        style={{
                          borderRadius: tokens.radius.xl,
                          border: `3px solid ${tokens.colors.bg.primary}`,
                          boxShadow: tokens.shadow.lg,
                        }}
                      />
                    ) : (
                      <Box
                        style={{
                          width: 80, height: 80,
                          borderRadius: tokens.radius.xl,
                          background: tokens.colors.bg.tertiary,
                          border: `3px solid ${tokens.colors.bg.primary}`,
                          display: 'grid', placeItems: 'center',
                          boxShadow: tokens.shadow.lg,
                        }}
                      >
                        <Text size="2xl" weight="black" color="tertiary">
                          {(handle?.[0] || email?.[0] || 'U').toUpperCase()}
                        </Text>
                      </Box>
                    )}
                    <input type="file" accept="image/*" onChange={handleAvatarChange} style={{ display: 'none' }} id="avatar-input" />
                    <label
                      htmlFor="avatar-input"
                      style={{
                        position: 'absolute',
                        bottom: -4,
                        right: -4,
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: tokens.gradient.primary,
                        border: `2px solid ${tokens.colors.bg.primary}`,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '12px',
                        color: '#fff',
                        boxShadow: tokens.shadow.md,
                      }}
                    >
                      +
                    </label>
                  </Box>
                  <Box style={{ paddingBottom: tokens.spacing[2] }}>
                    <Text size="xs" color="tertiary">头像 (最大 5MB) / 背景 (最大 10MB)</Text>
                    <Text size="xs" color="tertiary">支持 JPG, PNG, GIF, WebP</Text>
                  </Box>
                </Box>
              </Box>

              {/* Handle */}
              <Box style={{ marginBottom: tokens.spacing[4] }}>
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>用户名</Text>
                <input
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  onBlur={() => markTouched('handle')}
                  placeholder="设置您的用户名"
                  style={inputStyle(touchedFields.handle && !handleValidation.valid)}
                />
                {touchedFields.handle && handle && (
                  <Text size="xs" style={{ color: handleValidation.valid ? '#2fe57d' : '#ff7c7c', marginTop: 4 }}>
                    {handleValidation.valid ? '✓ 格式正确' : `✕ ${handleValidation.message}`}
                  </Text>
                )}
              </Box>

              {/* Bio */}
              <Box style={{ marginBottom: tokens.spacing[2] }}>
                <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
                  <Text size="sm" weight="bold">个人简介</Text>
                  <Text size="xs" color="tertiary">{bio.length}/200</Text>
                </Box>
                <textarea
                  value={bio}
                  onChange={(e) => { if (e.target.value.length <= 200) setBio(e.target.value) }}
                  placeholder="介绍一下自己..."
                  rows={4}
                  style={{
                    ...inputStyle(),
                    resize: 'vertical',
                    minHeight: 80,
                  }}
                />
              </Box>
            </div>

            {/* ====== SOCIAL LINKS SECTION ====== */}
            <div id="section-social" style={glassCardStyle}>
              <Box style={sectionTitleStyle}>
                <Text size="lg" weight="black">社交链接</Text>
                <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>添加您的社交媒体链接，让其他用户了解您</Text>
              </Box>

              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {/* Twitter/X */}
                <Box>
                  <Text size="xs" weight="bold" color="secondary" style={{ marginBottom: 4 }}>Twitter / X</Text>
                  <Box style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: tokens.colors.text.tertiary, fontSize: '13px' }}>@</span>
                    <input
                      type="text"
                      value={socialTwitter}
                      onChange={(e) => setSocialTwitter(e.target.value.replace('@', ''))}
                      placeholder="username"
                      style={{ ...inputStyle(), paddingLeft: '28px' }}
                    />
                  </Box>
                </Box>

                {/* Telegram */}
                <Box>
                  <Text size="xs" weight="bold" color="secondary" style={{ marginBottom: 4 }}>Telegram</Text>
                  <Box style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: tokens.colors.text.tertiary, fontSize: '13px' }}>@</span>
                    <input
                      type="text"
                      value={socialTelegram}
                      onChange={(e) => setSocialTelegram(e.target.value.replace('@', ''))}
                      placeholder="username"
                      style={{ ...inputStyle(), paddingLeft: '28px' }}
                    />
                  </Box>
                </Box>

                {/* Discord */}
                <Box>
                  <Text size="xs" weight="bold" color="secondary" style={{ marginBottom: 4 }}>Discord</Text>
                  <input
                    type="text"
                    value={socialDiscord}
                    onChange={(e) => setSocialDiscord(e.target.value)}
                    placeholder="username#0000 或邀请链接"
                    style={inputStyle()}
                  />
                </Box>

                {/* GitHub */}
                <Box>
                  <Text size="xs" weight="bold" color="secondary" style={{ marginBottom: 4 }}>GitHub</Text>
                  <Box style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: tokens.colors.text.tertiary, fontSize: '12px' }}>github.com/</span>
                    <input
                      type="text"
                      value={socialGithub}
                      onChange={(e) => setSocialGithub(e.target.value)}
                      placeholder="username"
                      style={{ ...inputStyle(), paddingLeft: '90px' }}
                    />
                  </Box>
                </Box>

                {/* Website */}
                <Box>
                  <Text size="xs" weight="bold" color="secondary" style={{ marginBottom: 4 }}>个人网站</Text>
                  <input
                    type="url"
                    value={socialWebsite}
                    onChange={(e) => setSocialWebsite(e.target.value)}
                    placeholder="https://your-website.com"
                    style={inputStyle()}
                  />
                </Box>
              </Box>
            </div>

            {/* ====== ACCOUNT SECTION ====== */}
            <div id="section-account" style={glassCardStyle}>
              <Box style={sectionTitleStyle}>
                <Text size="lg" weight="black">账号安全</Text>
                <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>管理您的邮箱和密码</Text>
              </Box>

              {/* Email */}
              <Box style={{ marginBottom: tokens.spacing[5] }}>
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>邮箱地址</Text>
                <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>当前：{email}</Text>
                <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    onBlur={() => markTouched('newEmail')}
                    placeholder="输入新邮箱"
                    style={{ ...inputStyle(touchedFields.newEmail && !newEmailValidation.valid), flex: 1 }}
                  />
                  <Button variant="secondary" size="sm" onClick={handleChangeEmail} disabled={savingEmail || !newEmail || !newEmailValidation.valid}>
                    {savingEmail ? '发送中...' : '验证'}
                  </Button>
                </Box>
                {touchedFields.newEmail && newEmail && !newEmailValidation.valid && (
                  <Text size="xs" style={{ color: '#ff7c7c', marginTop: 4 }}>✕ {newEmailValidation.message}</Text>
                )}
              </Box>

              {/* Password */}
              <Box>
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>修改密码</Text>

                {/* Mode toggle */}
                <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
                  <button
                    onClick={() => setPasswordResetMode('password')}
                    style={{
                      flex: 1,
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.lg,
                      border: `1px solid ${passwordResetMode === 'password' ? tokens.colors.accent.primary : tokens.colors.border.primary}40`,
                      background: passwordResetMode === 'password' ? `${tokens.colors.accent.primary}15` : 'transparent',
                      color: passwordResetMode === 'password' ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: tokens.typography.fontWeight.bold,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    使用当前密码
                  </button>
                  <button
                    onClick={() => setPasswordResetMode('code')}
                    style={{
                      flex: 1,
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.lg,
                      border: `1px solid ${passwordResetMode === 'code' ? tokens.colors.accent.primary : tokens.colors.border.primary}40`,
                      background: passwordResetMode === 'code' ? `${tokens.colors.accent.primary}15` : 'transparent',
                      color: passwordResetMode === 'code' ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: tokens.typography.fontWeight.bold,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    邮箱验证
                  </button>
                </Box>

                {passwordResetMode === 'password' ? (
                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                    <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="当前密码" style={inputStyle()} />
                    <Box>
                      <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} onBlur={() => markTouched('newPassword')} placeholder="新密码（至少6位）" style={inputStyle(touchedFields.newPassword && !newPasswordValidation.valid)} />
                      {touchedFields.newPassword && newPassword && !newPasswordValidation.valid && (
                        <Text size="xs" style={{ color: '#ff7c7c', marginTop: 4 }}>✕ {newPasswordValidation.message}</Text>
                      )}
                    </Box>
                    <Box>
                      <input type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} onBlur={() => markTouched('confirmPassword')} placeholder="确认新密码" style={inputStyle(touchedFields.confirmPassword && !confirmPasswordValidation.valid)} />
                      {touchedFields.confirmPassword && confirmNewPassword && (
                        <Text size="xs" style={{ color: confirmPasswordValidation.valid ? '#2fe57d' : '#ff7c7c', marginTop: 4 }}>
                          {confirmPasswordValidation.valid ? '✓ 密码匹配' : `✕ ${confirmPasswordValidation.message}`}
                        </Text>
                      )}
                    </Box>
                    <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button variant="secondary" size="sm" onClick={handleChangePassword} disabled={savingPassword || !currentPassword || !newPasswordValidation.valid || !confirmPasswordValidation.valid}>
                        {savingPassword ? '修改中...' : '修改密码'}
                      </Button>
                    </Box>
                  </Box>
                ) : (
                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                    <Text size="xs" color="tertiary">将发送密码重置链接到您的邮箱：{email}</Text>
                    <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button variant="secondary" size="sm" onClick={handleSendResetCode} disabled={sendingResetCode || resetCountdown > 0}>
                        {sendingResetCode ? '发送中...' : resetCountdown > 0 ? `${resetCountdown}秒后重发` : resetCodeSent ? '重新发送' : '发送重置邮件'}
                      </Button>
                    </Box>
                    {resetCodeSent && (
                      <Box style={{ padding: tokens.spacing[3], borderRadius: tokens.radius.md, background: `${tokens.colors.accent.success}10`, border: `1px solid ${tokens.colors.accent.success}30` }}>
                        <Text size="xs" style={{ color: tokens.colors.accent.success }}>✓ 重置邮件已发送，请查收邮箱</Text>
                      </Box>
                    )}
                  </Box>
                )}
              </Box>

              {/* Exchange Connection */}
              {userId && (
                <Box style={{ marginTop: tokens.spacing[5], paddingTop: tokens.spacing[5], borderTop: `1px solid ${tokens.colors.border.primary}40` }}>
                  <ExchangeConnectionManager userId={userId} />
                </Box>
              )}
            </div>

            {/* ====== NOTIFICATIONS SECTION ====== */}
            <div id="section-notifications" style={glassCardStyle}>
              <Box style={sectionTitleStyle}>
                <Text size="lg" weight="black">通知偏好</Text>
                <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>选择您希望接收的通知类型</Text>
              </Box>

              <SettingRow label="关注通知" description="有人关注我时通知">
                <ToggleSwitch checked={notifyFollow} onChange={setNotifyFollow} />
              </SettingRow>
              <SettingRow label="点赞通知" description="有人点赞我的帖子时通知">
                <ToggleSwitch checked={notifyLike} onChange={setNotifyLike} />
              </SettingRow>
              <SettingRow label="评论通知" description="有人评论我的帖子时通知">
                <ToggleSwitch checked={notifyComment} onChange={setNotifyComment} />
              </SettingRow>
              <SettingRow label="提及通知" description="有人 @提及我时通知">
                <ToggleSwitch checked={notifyMention} onChange={setNotifyMention} />
              </SettingRow>
              <SettingRow label="私信通知" description="收到私信时通知">
                <ToggleSwitch checked={notifyMessage} onChange={setNotifyMessage} />
              </SettingRow>
            </div>

            {/* ====== PRIVACY SECTION ====== */}
            <div id="section-privacy" style={glassCardStyle}>
              <Box style={sectionTitleStyle}>
                <Text size="lg" weight="black">隐私设置</Text>
                <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>控制他人可以看到的信息</Text>
              </Box>

              <SettingRow label="展示关注列表" description="关闭后他人无法查看你关注了谁">
                <ToggleSwitch checked={showFollowing} onChange={setShowFollowing} />
              </SettingRow>
              <SettingRow label="展示粉丝列表" description="关闭后他人无法查看你的粉丝">
                <ToggleSwitch checked={showFollowers} onChange={setShowFollowers} />
              </SettingRow>
              <SettingRow label="显示 Pro 徽章" description="关闭后主页不显示会员徽章">
                <ToggleSwitch checked={showProBadge} onChange={setShowProBadge} />
              </SettingRow>

              {/* DM Permission */}
              <Box style={{ marginTop: tokens.spacing[4], paddingTop: tokens.spacing[3] }}>
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>私信权限</Text>
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                  {([
                    { value: 'all' as const, label: '所有人', desc: '任何人都可以给我发私信' },
                    { value: 'mutual' as const, label: '互相关注', desc: '互相关注可无限私信，非互关最多3条' },
                    { value: 'none' as const, label: '关闭私信', desc: '不接收任何人的私信' },
                  ]).map((option) => (
                    <label
                      key={option.value}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[3],
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        borderRadius: tokens.radius.lg,
                        cursor: 'pointer',
                        background: dmPermission === option.value ? `${tokens.colors.accent.primary}10` : 'transparent',
                        border: `1px solid ${dmPermission === option.value ? tokens.colors.accent.primary + '40' : 'transparent'}`,
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <input
                        type="radio"
                        name="dmPermission"
                        checked={dmPermission === option.value}
                        onChange={() => setDmPermission(option.value)}
                        style={{ width: 16, height: 16, accentColor: tokens.colors.accent.primary }}
                      />
                      <Box>
                        <Text size="sm">{option.label}</Text>
                        <Text size="xs" color="tertiary">{option.desc}</Text>
                      </Box>
                    </label>
                  ))}
                </Box>
              </Box>
            </div>

            {/* ====== DISPLAY SECTION ====== */}
            <div id="section-display" style={glassCardStyle}>
              <Box style={sectionTitleStyle}>
                <Text size="lg" weight="black">显示偏好</Text>
                <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>自定义界面显示方式</Text>
              </Box>

              {/* Theme Selection */}
              <Box style={{ marginBottom: tokens.spacing[5] }}>
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>主题</Text>
                <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                  {([
                    { value: 'dark' as ThemeMode, label: '深色', preview: '#0B0A10' },
                    { value: 'light' as ThemeMode, label: '浅色', preview: '#F8F9FA' },
                    { value: 'system' as ThemeMode, label: '跟随系统', preview: 'linear-gradient(135deg, #0B0A10 50%, #F8F9FA 50%)' },
                  ]).map((theme) => (
                    <button
                      key={theme.value}
                      onClick={() => updateAppSettings({ theme: theme.value })}
                      style={{
                        flex: 1,
                        padding: tokens.spacing[3],
                        borderRadius: tokens.radius.lg,
                        border: `2px solid ${appSettings.theme === theme.value ? tokens.colors.accent.primary : tokens.colors.border.primary}40`,
                        background: appSettings.theme === theme.value ? `${tokens.colors.accent.primary}10` : 'transparent',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                      }}
                    >
                      <Box
                        style={{
                          width: 40,
                          height: 28,
                          borderRadius: tokens.radius.md,
                          background: theme.preview,
                          border: `1px solid ${tokens.colors.border.primary}`,
                        }}
                      />
                      <Text
                        size="xs"
                        weight={appSettings.theme === theme.value ? 'bold' : 'medium'}
                        style={{ color: appSettings.theme === theme.value ? tokens.colors.accent.primary : tokens.colors.text.secondary }}
                      >
                        {theme.label}
                      </Text>
                    </button>
                  ))}
                </Box>
              </Box>

              {/* Language */}
              <Box style={{ marginBottom: tokens.spacing[4] }}>
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>语言</Text>
                <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                  {([
                    { value: 'zh' as const, label: '中文' },
                    { value: 'en' as const, label: 'English' },
                  ]).map((lang) => (
                    <button
                      key={lang.value}
                      onClick={() => updateAppSettings({ language: lang.value })}
                      style={{
                        flex: 1,
                        padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                        borderRadius: tokens.radius.lg,
                        border: `1px solid ${appSettings.language === lang.value ? tokens.colors.accent.primary : tokens.colors.border.primary}40`,
                        background: appSettings.language === lang.value ? `${tokens.colors.accent.primary}15` : 'transparent',
                        color: appSettings.language === lang.value ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                        fontSize: tokens.typography.fontSize.sm,
                        fontWeight: appSettings.language === lang.value ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {lang.label}
                    </button>
                  ))}
                </Box>
              </Box>

              {/* Compact mode and other settings */}
              <SettingRow label="紧凑模式" description="减少页面间距，显示更多内容">
                <ToggleSwitch checked={appSettings.compactMode} onChange={(v) => updateAppSettings({ compactMode: v })} />
              </SettingRow>
              <SettingRow label="显示头像" description="在列表中显示用户头像">
                <ToggleSwitch checked={appSettings.showAvatars} onChange={(v) => updateAppSettings({ showAvatars: v })} />
              </SettingRow>
              <SettingRow label="自动播放视频" description="帖子中的视频自动播放">
                <ToggleSwitch checked={appSettings.autoPlayVideos} onChange={(v) => updateAppSettings({ autoPlayVideos: v })} />
              </SettingRow>
              <SettingRow label="声音提示" description="操作时播放提示音">
                <ToggleSwitch checked={appSettings.soundEnabled} onChange={(v) => updateAppSettings({ soundEnabled: v })} />
              </SettingRow>
            </div>

            {/* ====== DANGER ZONE ====== */}
            <div id="section-danger" style={{ ...glassCardStyle, border: `1px solid ${tokens.colors.accent.error}30` }}>
              <Box style={sectionTitleStyle}>
                <Text size="lg" weight="black" style={{ color: tokens.colors.accent.error }}>账号管理</Text>
                <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>退出登录或删除账号</Text>
              </Box>

              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${tokens.spacing[3]} 0` }}>
                  <Box>
                    <Text size="sm" weight="medium">退出登录</Text>
                    <Text size="xs" color="tertiary">退出当前账号</Text>
                  </Box>
                  <Button variant="secondary" size="sm" onClick={handleLogout}>退出登录</Button>
                </Box>

                <Box style={{ borderTop: `1px solid ${tokens.colors.accent.error}20`, paddingTop: tokens.spacing[3], display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Box>
                    <Text size="sm" weight="medium" style={{ color: tokens.colors.accent.error }}>删除账号</Text>
                    <Text size="xs" color="tertiary">永久删除账号及所有数据，不可恢复</Text>
                  </Box>
                  <Button variant="danger" size="sm" onClick={handleDeleteAccount}>删除账号</Button>
                </Box>
              </Box>
            </div>
          </Box>
        </Box>
      </Box>

      {/* Floating Save Bar */}
      {hasUnsavedChanges() && (
        <Box
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
            background: tokens.glass.bg.heavy,
            backdropFilter: tokens.glass.blur.xl,
            WebkitBackdropFilter: tokens.glass.blur.xl,
            borderTop: tokens.glass.border.medium,
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: tokens.spacing[4],
            animation: 'slideUp 0.3s ease',
          }}
        >
          <Text size="sm" style={{ color: '#ffc107' }}>您有未保存的更改</Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (hasUnsavedChanges()) {
                  const confirmed = await showConfirm('放弃更改', '确定要放弃所有未保存的更改吗？')
                  if (!confirmed) return
                }
                router.back()
              }}
              disabled={saving}
            >
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={saving} loading={saving}>
              {saving ? '保存中...' : '保存更改'}
            </Button>
          </Box>
        </Box>
      )}

      {/* Responsive styles */}
      <style jsx global>{`
        @keyframes slideUp {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @media (max-width: 768px) {
          .settings-sidebar {
            display: none !important;
          }
          .page-enter > div:nth-child(3) {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </Box>
  )
}
