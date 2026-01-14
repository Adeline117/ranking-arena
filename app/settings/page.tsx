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
  
  // Initial values for tracking changes
  const initialValuesRef = useRef<{
    handle: string
    bio: string
    avatarUrl: string | null
    notifyFollow: boolean
    notifyLike: boolean
    notifyComment: boolean
    notifyMention: boolean
  } | null>(null)
  
  // Password change
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  
  // Email change
  const [newEmail, setNewEmail] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)
  
  // Notification preferences
  const [notifyFollow, setNotifyFollow] = useState(true)
  const [notifyLike, setNotifyLike] = useState(true)
  const [notifyComment, setNotifyComment] = useState(true)
  const [notifyMention, setNotifyMention] = useState(true)
  const [savingNotifications, setSavingNotifications] = useState(false)

  // Check if there are unsaved changes
  const hasUnsavedChanges = useCallback(() => {
    if (!initialValuesRef.current) return false
    const initial = initialValuesRef.current
    return (
      handle !== initial.handle ||
      bio !== initial.bio ||
      avatarFile !== null ||
      notifyFollow !== initial.notifyFollow ||
      notifyLike !== initial.notifyLike ||
      notifyComment !== initial.notifyComment ||
      notifyMention !== initial.notifyMention
    )
  }, [handle, bio, avatarFile, notifyFollow, notifyLike, notifyComment, notifyMention])

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
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle, bio, avatar_url, notify_follow, notify_like, notify_comment, notify_mention')
        .eq('id', uid)
        .maybeSingle()
      
      if (userProfile) {
        const profileHandle = userProfile.handle || ''
        const profileBio = userProfile.bio || ''
        const profileAvatarUrl = userProfile.avatar_url || null
        const profileNotifyFollow = userProfile.notify_follow !== false
        const profileNotifyLike = userProfile.notify_like !== false
        const profileNotifyComment = userProfile.notify_comment !== false
        const profileNotifyMention = userProfile.notify_mention !== false
        
        setHandle(profileHandle)
        setBio(profileBio)
        setAvatarUrl(profileAvatarUrl)
        setPreviewUrl(profileAvatarUrl)
        setNotifyFollow(profileNotifyFollow)
        setNotifyLike(profileNotifyLike)
        setNotifyComment(profileNotifyComment)
        setNotifyMention(profileNotifyMention)
        
        // Store initial values for change detection
        initialValuesRef.current = {
          handle: profileHandle,
          bio: profileBio,
          avatarUrl: profileAvatarUrl,
          notifyFollow: profileNotifyFollow,
          notifyLike: profileNotifyLike,
          notifyComment: profileNotifyComment,
          notifyMention: profileNotifyMention,
        }
      }

    } catch (error) {
      console.error('Error loading profile:', error)
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

  const uploadAvatar = async (file: File, userId: string): Promise<string | null> => {
    try {
      const fileExt = file.name.split('.').pop()
      const fileName = `${userId}-${Date.now()}.${fileExt}`
      const filePath = `avatars/${fileName}`

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true })

      if (uploadError) {
        console.error('Upload error:', uploadError)
        return null
      }

      const { data } = supabase.storage.from('avatars').getPublicUrl(filePath)
      return data.publicUrl
    } catch (error) {
      console.error('Error uploading avatar:', error)
      return null
    }
  }

  const handleSave = async () => {
    if (!userId) return
    
    setSaving(true)
    try {
      let finalAvatarUrl = avatarUrl
      
      // Upload avatar if changed
      if (avatarFile) {
        const uploadedUrl = await uploadAvatar(avatarFile, userId)
        if (uploadedUrl) {
          finalAvatarUrl = uploadedUrl
        }
      }
      
      // Update profile and notification preferences in user_profiles (consolidated save)
      const { error: userProfilesError } = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: userId,
            handle: handle || null,
            bio: bio || null,
            avatar_url: finalAvatarUrl || null,
            notify_follow: notifyFollow,
            notify_like: notifyLike,
            notify_comment: notifyComment,
            notify_mention: notifyMention,
          },
          { onConflict: 'id' }
        )
      
      if (userProfilesError) {
        console.error('Error saving profile:', userProfilesError)
        showToast('保存失败，请重试', 'error')
        return
      }
      
      // Update initial values after successful save
      initialValuesRef.current = {
        handle,
        bio,
        avatarUrl: finalAvatarUrl,
        notifyFollow,
        notifyLike,
        notifyComment,
        notifyMention,
      }
      setAvatarFile(null) // Clear avatar file state
      
      showToast('保存成功！', 'success')
      router.push(`/u/${handle || userId}`)
    } catch (error) {
      console.error('Error saving:', error)
      showToast('保存失败，请重试', 'error')
    } finally {
      setSaving(false)
    }
  }

  // 修改密码
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
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          编辑个人资料
        </Text>

        {/* Avatar Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
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

        {/* Handle Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            用户名
          </Text>
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="输入用户名"
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
        </Box>

        {/* Bio Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            个人简介
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
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
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
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新密码（至少6位）"
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
            <input
              type="password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder="确认新密码"
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
            <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                variant="secondary"
                onClick={handleChangePassword}
                disabled={savingPassword}
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
          <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="输入新邮箱地址"
              style={{
                flex: 1,
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
            <Button
              variant="secondary"
              onClick={handleChangeEmail}
              disabled={savingEmail}
            >
              {savingEmail ? '发送中...' : '发送验证'}
            </Button>
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
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
              通知偏好将与个人资料一起保存
            </Text>
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
              ⚠️ 您有未保存的更改
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


