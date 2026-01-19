'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import Avatar from '@/app/components/UI/Avatar'
import ExchangeConnectionManager from '@/app/components/ExchangeConnection'
import { useToast } from '@/app/components/UI/Toast'
import { useDialog } from '@/app/components/UI/Dialog'
import { uiLogger } from '@/lib/utils/logger'

// 实时验证函数
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

export default function SettingsPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  
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
  } | null>(null)
  
  // Password change
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordResetMode, setPasswordResetMode] = useState<'password' | 'code'>('password')
  const [resetCode, setResetCode] = useState('')
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

  // 实时验证状态
  const [touchedFields, setTouchedFields] = useState<{
    handle: boolean
    newPassword: boolean
    confirmPassword: boolean
    newEmail: boolean
  }>({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })

  // 验证结果
  const handleValidation = validateHandle(handle)
  const newPasswordValidation = validatePassword(newPassword)
  const confirmPasswordValidation = validatePasswordMatch(newPassword, confirmNewPassword)
  const newEmailValidation = validateEmail(newEmail)

  // 标记字段为已触摸
  const markTouched = (field: keyof typeof touchedFields) => {
    setTouchedFields(prev => ({ ...prev, [field]: true }))
  }

  // Check if there are unsaved changes
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
      dmPermission !== initial.dmPermission
    )
  }, [handle, bio, avatarFile, coverFile, notifyFollow, notifyLike, notifyComment, notifyMention, notifyMessage, showFollowers, showFollowing, dmPermission])

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
      
      // Load profile
      loadProfile(data.user.id)
    })
  }, [router])

  const loadProfile = async (uid: string) => {
    try {
      setLoading(true)
      
      // 只使用 user_profiles（避免访问不存在的 profiles 表）
      // Note: dm_permission 暂时移除，等运行迁移后再添加
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle, bio, avatar_url, cover_url, notify_follow, notify_like, notify_comment, notify_mention, notify_message, show_followers, show_following')
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
        const profileDmPermission = 'all' // TODO: 运行迁移后改为 userProfile.dm_permission || 'all'
        
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
        
        // Store initial values for change detection
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
      setCoverFile(file)
      const reader = new FileReader()
      reader.onloadend = () => {
        setCoverPreviewUrl(reader.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  const uploadCover = async (file: File, userId: string): Promise<string | null> => {
    try {
      // 检查文件大小（最大 10MB - 背景图片可以更大一些）
      if (file.size > 10 * 1024 * 1024) {
        showToast('图片大小不能超过 10MB', 'error')
        return null
      }

      const fileExt = file.name.split('.').pop()?.toLowerCase()
      // 检查文件类型
      if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt || '')) {
        showToast('只支持 JPG、PNG、GIF、WebP 格式', 'error')
        return null
      }

      const fileName = `${userId}-${Date.now()}.${fileExt}`
      const filePath = `${fileName}`

      const { error: uploadError } = await supabase.storage
        .from('covers')
        .upload(filePath, file, { upsert: true })

      if (uploadError) {
        uiLogger.error('Cover upload error:', uploadError)
        if (uploadError.message?.includes('Bucket not found')) {
          showToast('存储服务未配置，请联系管理员运行 setup_cover_storage.sql', 'error')
        } else if (uploadError.message?.includes('security') || uploadError.message?.includes('policy')) {
          showToast('没有上传权限，请联系管理员', 'error')
        } else {
          showToast(`上传失败: ${uploadError.message}`, 'error')
        }
        return null
      }

      const { data } = supabase.storage.from('covers').getPublicUrl(filePath)
      return data.publicUrl
    } catch (error: any) {
      showToast(`上传异常: ${error?.message || '未知错误'}`, 'error')
      return null
    }
  }

  const uploadAvatar = async (file: File, userId: string): Promise<string | null> => {
    try {
      // 检查文件大小（最大 5MB）
      if (file.size > 5 * 1024 * 1024) {
        showToast('图片大小不能超过 5MB', 'error')
        return null
      }

      const fileExt = file.name.split('.').pop()?.toLowerCase()
      // 检查文件类型
      if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt || '')) {
        showToast('只支持 JPG、PNG、GIF、WebP 格式', 'error')
        return null
      }

      const fileName = `${userId}-${Date.now()}.${fileExt}`
      const filePath = `${fileName}`  // 不需要 avatars/ 前缀，因为 bucket 名就是 avatars

      const { error: uploadError, data: uploadData } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true })

      if (uploadError) {
        uiLogger.error('Avatar upload error:', uploadError)
        // 显示具体的错误信息
        if (uploadError.message?.includes('Bucket not found')) {
          showToast('存储服务未配置，请联系管理员', 'error')
        } else if (uploadError.message?.includes('security') || uploadError.message?.includes('policy')) {
          showToast('没有上传权限，请联系管理员', 'error')
        } else {
          showToast(`上传失败: ${uploadError.message}`, 'error')
        }
        return null
      }

      const { data } = supabase.storage.from('avatars').getPublicUrl(filePath)
      return data.publicUrl
    } catch (error: any) {
      showToast(`上传异常: ${error?.message || '未知错误'}`, 'error')
      return null
    }
  }

  const handleSave = async () => {
    if (!userId) return
    
    setSaving(true)
    try {
      let finalAvatarUrl = avatarUrl
      let finalCoverUrl = coverUrl
      
      // Upload avatar if changed
      if (avatarFile) {
        const uploadedUrl = await uploadAvatar(avatarFile, userId)
        if (uploadedUrl) {
          finalAvatarUrl = uploadedUrl
        }
        // 上传失败时不阻止其他数据保存，继续使用旧头像
      }
      
      // Upload cover if changed
      if (coverFile) {
        const uploadedUrl = await uploadCover(coverFile, userId)
        if (uploadedUrl) {
          finalCoverUrl = uploadedUrl
        }
        // 上传失败时不阻止其他数据保存，继续使用旧背景
      }
      
      // Update profile and notification preferences in user_profiles (consolidated save)
      // Note: dm_permission is excluded to avoid errors if column doesn't exist
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
            // dm_permission: dmPermission, // TODO: 运行 setup_user_messaging.sql 后取消注释
          },
          { onConflict: 'id' }
        )
      
      if (userProfilesError) {
        uiLogger.error('Error saving profile:', JSON.stringify(userProfilesError, null, 2))
        uiLogger.error('Error details - code:', userProfilesError.code, 'message:', userProfilesError.message, 'hint:', userProfilesError.hint)
        // 处理 handle 重复的错误
        if (userProfilesError.code === '23505' || userProfilesError.message?.includes('unique') || userProfilesError.message?.includes('duplicate')) {
          showToast('用户名已被使用，请选择其他用户名', 'error')
        } else {
          showToast(`保存失败: ${userProfilesError.message || '请重试'}`, 'error')
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
      }
      setAvatarFile(null) // Clear avatar file state
      setCoverFile(null) // Clear cover file state
      
      showToast('保存成功！', 'success')
      router.push(`/u/${handle || userId}`)
    } catch (error) {
      uiLogger.error('Error saving:', error)
      showToast('保存失败，请重试', 'error')
    } finally {
      setSaving(false)
    }
  }

  // 重置验证码倒计时
  useEffect(() => {
    if (resetCountdown > 0) {
      const timer = setTimeout(() => setResetCountdown(resetCountdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [resetCountdown])

  // 发送密码重置验证码
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
    } catch (error: any) {
      showToast(error?.message || '发送失败', 'error')
    } finally {
      setSendingResetCode(false)
    }
  }

  // 修改密码（通过当前密码）
  const handleChangePassword = async () => {
    if (!currentPassword) {
      showToast('请输入当前密码', 'warning')
      return
    }
    if (!newPassword) {
      showToast('请输入新密码', 'warning')
      return
    }
    if (newPassword.length < 6) {
      showToast('密码至少6位', 'warning')
      return
    }
    if (newPassword !== confirmNewPassword) {
      showToast('两次输入的密码不一致', 'warning')
      return
    }

    setSavingPassword(true)
    try {
      // 首先验证当前密码是否正确
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

      // 当前密码验证通过，更新新密码
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      })

      if (error) {
        showToast(error.message, 'error')
        return
      }

      showToast('密码修改成功！', 'success')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
    } catch (error: any) {
      showToast(error?.message || '修改失败', 'error')
    } finally {
      setSavingPassword(false)
    }
  }

  // 修改邮箱
  const handleChangeEmail = async () => {
    if (!newEmail) {
      showToast('请输入新邮箱', 'warning')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
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
    } catch (error: any) {
      showToast(error?.message || '修改失败', 'error')
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
    } catch (error) {
      showToast('保存失败', 'error')
    } finally {
      setSavingNotifications(false)
    }
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary, position: 'relative' }}>
      {/* Background mesh */}
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: tokens.gradient.mesh,
          opacity: 0.4,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      
      <TopNav email={email} />
      
      <Box className="page-enter" style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], position: 'relative', zIndex: 1 }}>
        <Text size="2xl" weight="black" className="gradient-text" style={{ marginBottom: tokens.spacing[6] }}>
          编辑个人资料
        </Text>

        {/* Avatar Section */}
        <Box
          className="glass-card card-enter"
          p={6}
          radius="xl"
          style={{ 
            marginBottom: tokens.spacing[6],
            background: tokens.glass.bg.secondary,
            backdropFilter: tokens.glass.blur.lg,
            WebkitBackdropFilter: tokens.glass.blur.lg,
            border: tokens.glass.border.light,
            animationDelay: '0.1s',
          }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            头像
          </Text>
          
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
            {userId ? (
              <Avatar
                userId={userId}
                name={handle || email}
                avatarUrl={previewUrl}
                size={100}
                style={{
                  borderRadius: tokens.radius.xl,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              />
            ) : (
              <Box
                style={{
                  width: 100,
                  height: 100,
                  borderRadius: tokens.radius.xl,
                  background: tokens.colors.bg.tertiary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  display: 'grid',
                  placeItems: 'center',
                  overflow: 'hidden',
                  flexShrink: 0,
                }}
              >
                <Text size="3xl" weight="black" style={{ color: tokens.colors.text.secondary }}>
                  {(handle?.[0] || email?.[0] || 'U').toUpperCase()}
                </Text>
              </Box>
            )}
            
            <Box>
              <input
                type="file"
                accept="image/*"
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
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  cursor: 'pointer',
                  fontWeight: tokens.typography.fontWeight.bold,
                  fontSize: tokens.typography.fontSize.sm,
                }}
              >
                选择图片
              </label>
              <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1], display: 'block' }}>
                支持 JPG、PNG 格式，最大 5MB
              </Text>
            </Box>
          </Box>
        </Box>

        {/* Cover Section */}
        <Box
          className="glass-card card-enter"
          p={6}
          radius="xl"
          style={{ 
            marginBottom: tokens.spacing[6],
            background: tokens.glass.bg.secondary,
            backdropFilter: tokens.glass.blur.lg,
            WebkitBackdropFilter: tokens.glass.blur.lg,
            border: tokens.glass.border.light,
            animationDelay: '0.12s',
          }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            背景图片
          </Text>
          
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {/* Cover Preview */}
            <Box
              style={{
                width: '100%',
                height: 160,
                borderRadius: tokens.radius.lg,
                background: coverPreviewUrl 
                  ? `url(${coverPreviewUrl}) center/cover no-repeat`
                  : `linear-gradient(135deg, ${tokens.colors.bg.tertiary} 0%, ${tokens.colors.bg.secondary} 100%)`,
                border: `1px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {!coverPreviewUrl && (
                <Text size="sm" color="tertiary">
                  暂无背景图片
                </Text>
              )}
            </Box>
            
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
              <input
                type="file"
                accept="image/*"
                onChange={handleCoverChange}
                style={{ display: 'none' }}
                id="cover-input"
              />
              <label
                htmlFor="cover-input"
                style={{
                  display: 'inline-block',
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  cursor: 'pointer',
                  fontWeight: tokens.typography.fontWeight.bold,
                  fontSize: tokens.typography.fontSize.sm,
                }}
              >
                选择图片
              </label>
              {coverPreviewUrl && (
                <button
                  onClick={() => {
                    setCoverFile(null)
                    setCoverPreviewUrl(null)
                    setCoverUrl(null)
                  }}
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.accent.error}40`,
                    background: 'transparent',
                    color: tokens.colors.accent.error,
                    cursor: 'pointer',
                    fontWeight: tokens.typography.fontWeight.bold,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
                  移除背景
                </button>
              )}
            </Box>
            <Text size="xs" color="tertiary">
              支持 JPG、PNG、GIF、WebP 格式，最大 10MB，建议尺寸 1200×400
            </Text>
          </Box>
        </Box>

        {/* Handle Section */}
        <Box
          className="glass-card card-enter"
          p={6}
          radius="xl"
          style={{ 
            marginBottom: tokens.spacing[6],
            background: tokens.glass.bg.secondary,
            backdropFilter: tokens.glass.blur.lg,
            WebkitBackdropFilter: tokens.glass.blur.lg,
            border: tokens.glass.border.light,
            animationDelay: '0.15s',
          }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            用户名
          </Text>
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            onBlur={() => markTouched('handle')}
            placeholder="输入用户名"
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              border: `1px solid ${touchedFields.handle && !handleValidation.valid ? '#ff7c7c' : tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              outline: 'none',
              transition: 'border-color 0.2s ease',
            }}
          />
          {/* 实时用户名验证 */}
          {touchedFields.handle && handle && (
            <Box style={{ marginTop: tokens.spacing[2], display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
              {handleValidation.valid ? (
                <Text size="xs" style={{ color: '#2fe57d' }}>✓ 用户名格式正确</Text>
              ) : (
                <Text size="xs" style={{ color: '#ff7c7c' }}>✕ {handleValidation.message}</Text>
              )}
            </Box>
          )}
          {/* 字符计数 */}
          {handle && (
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
              {handle.length}/1 字符（最少）
            </Text>
          )}
        </Box>

        {/* Bio Section */}
        <Box
          className="glass-card card-enter"
          p={6}
          radius="xl"
          style={{ 
            marginBottom: tokens.spacing[6],
            background: tokens.glass.bg.secondary,
            backdropFilter: tokens.glass.blur.lg,
            WebkitBackdropFilter: tokens.glass.blur.lg,
            border: tokens.glass.border.light,
            animationDelay: '0.2s',
          }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            关于我
          </Text>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="介绍一下自己..."
            rows={6}
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              outline: 'none',
              resize: 'vertical',
            }}
          />
        </Box>

        {/* Exchange Connection Section */}
        <Box
          className="glass-card card-enter"
          p={6}
          radius="xl"
          style={{ 
            marginBottom: tokens.spacing[6],
            background: tokens.glass.bg.secondary,
            backdropFilter: tokens.glass.blur.lg,
            WebkitBackdropFilter: tokens.glass.blur.lg,
            border: tokens.glass.border.light,
            animationDelay: '0.25s',
          }}
        >
          {userId && (
            <ExchangeConnectionManager userId={userId} />
          )}
        </Box>

        {/* Password Change Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            修改密码
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="当前密码"
              style={{
                width: '100%',
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.base,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                outline: 'none',
              }}
            />
            <Box>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onBlur={() => markTouched('newPassword')}
                placeholder="新密码（至少6位）"
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${touchedFields.newPassword && !newPasswordValidation.valid ? '#ff7c7c' : tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                  transition: 'border-color 0.2s ease',
                }}
              />
              {/* 实时密码验证 */}
              {touchedFields.newPassword && newPassword && !newPasswordValidation.valid && (
                <Text size="xs" style={{ color: '#ff7c7c', marginTop: tokens.spacing[1] }}>
                  ✕ {newPasswordValidation.message}
                </Text>
              )}
              {newPassword && (
                <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                  {newPassword.length}/6 字符
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
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${touchedFields.confirmPassword && !confirmPasswordValidation.valid ? '#ff7c7c' : tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                  transition: 'border-color 0.2s ease',
                }}
              />
              {/* 确认密码匹配验证 */}
              {touchedFields.confirmPassword && confirmNewPassword && (
                <Box style={{ marginTop: tokens.spacing[1] }}>
                  {confirmPasswordValidation.valid ? (
                    <Text size="xs" style={{ color: '#2fe57d' }}>✓ 密码匹配</Text>
                  ) : (
                    <Text size="xs" style={{ color: '#ff7c7c' }}>✕ {confirmPasswordValidation.message}</Text>
                  )}
                </Box>
              )}
            </Box>
            <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                variant="secondary"
                onClick={handleChangePassword}
                disabled={savingPassword || !currentPassword || !newPasswordValidation.valid || !confirmPasswordValidation.valid}
              >
                {savingPassword ? '保存中...' : '修改密码'}
              </Button>
            </Box>
          </Box>
        </Box>

        {/* Email Change Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
            修改邮箱
          </Text>
          <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
            当前邮箱：{email}
          </Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[3], flexDirection: 'column' }}>
            <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onBlur={() => markTouched('newEmail')}
                placeholder="输入新邮箱地址"
                style={{
                  flex: 1,
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${touchedFields.newEmail && !newEmailValidation.valid ? '#ff7c7c' : tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                  transition: 'border-color 0.2s ease',
                }}
              />
              <Button
                variant="secondary"
                onClick={handleChangeEmail}
                disabled={savingEmail || !newEmail || !newEmailValidation.valid}
              >
                {savingEmail ? '发送中...' : '发送验证'}
              </Button>
            </Box>
            {/* 实时邮箱验证 */}
            {touchedFields.newEmail && newEmail && (
              <Box>
                {newEmailValidation.valid ? (
                  <Text size="xs" style={{ color: '#2fe57d' }}>✓ 邮箱格式正确</Text>
                ) : (
                  <Text size="xs" style={{ color: '#ff7c7c' }}>✕ {newEmailValidation.message}</Text>
                )}
              </Box>
            )}
          </Box>
        </Box>

        {/* Notification Preferences Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            通知偏好
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={notifyFollow}
                onChange={(e) => setNotifyFollow(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
              />
              <Text size="sm">有人关注我时通知</Text>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={notifyLike}
                onChange={(e) => setNotifyLike(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
              />
              <Text size="sm">有人点赞我的帖子时通知</Text>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={notifyComment}
                onChange={(e) => setNotifyComment(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
              />
              <Text size="sm">有人评论我的帖子时通知</Text>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={notifyMention}
                onChange={(e) => setNotifyMention(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
              />
              <Text size="sm">有人 @提及 我时通知</Text>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={notifyMessage}
                onChange={(e) => setNotifyMessage(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
              />
              <Text size="sm">收到私信时通知</Text>
            </label>
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
              通知偏好将与个人资料一起保存
            </Text>
          </Box>
        </Box>

        {/* Privacy Settings Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            隐私设置
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {/* 关注列表可见性 */}
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                关注列表可见性
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={showFollowing}
                    onChange={(e) => setShowFollowing(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                  />
                  <Text size="sm">展示我的关注列表</Text>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={showFollowers}
                    onChange={(e) => setShowFollowers(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                  />
                  <Text size="sm">展示我的粉丝列表</Text>
                </label>
              </Box>
              <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                关闭后，其他用户将无法查看你的关注/粉丝列表
              </Text>
            </Box>

            {/* 私信权限 */}
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                私信权限
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="dmPermission"
                    checked={dmPermission === 'all'}
                    onChange={() => setDmPermission('all')}
                    style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                  />
                  <Box>
                    <Text size="sm">所有人</Text>
                    <Text size="xs" color="tertiary">任何人都可以给我发私信</Text>
                  </Box>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="dmPermission"
                    checked={dmPermission === 'mutual'}
                    onChange={() => setDmPermission('mutual')}
                    style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                  />
                  <Box>
                    <Text size="sm">互相关注</Text>
                    <Text size="xs" color="tertiary">互相关注可以无限私信，非互关最多发3条消息（我回复后对方可继续）</Text>
                  </Box>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="dmPermission"
                    checked={dmPermission === 'none'}
                    onChange={() => setDmPermission('none')}
                    style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                  />
                  <Box>
                    <Text size="sm">关闭私信</Text>
                    <Text size="xs" color="tertiary">不接收任何人的私信</Text>
                  </Box>
                </label>
              </Box>
            </Box>
          </Box>
        </Box>

        {/* Unsaved Changes Indicator */}
        {hasUnsavedChanges() && (
          <Box
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              marginBottom: tokens.spacing[4],
              borderRadius: tokens.radius.md,
              background: 'rgba(255, 193, 7, 0.1)',
              border: '1px solid rgba(255, 193, 7, 0.3)',
            }}
          >
            <Text size="sm" style={{ color: '#ffc107' }}>
              您有未保存的更改
            </Text>
          </Box>
        )}

        {/* Save Button */}
        <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: tokens.spacing[3] }}>
          <Button
            variant="secondary"
            onClick={async () => {
              if (hasUnsavedChanges()) {
                const confirmed = await showConfirm(
                  '放弃更改',
                  '您有未保存的更改，确定要离开吗？'
                )
                if (!confirmed) return
              }
              router.back()
            }}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? '保存中...' : '保存所有更改'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}


