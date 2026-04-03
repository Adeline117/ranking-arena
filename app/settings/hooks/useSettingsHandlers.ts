'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { uiLogger } from '@/lib/utils/logger'
import { logger } from '@/lib/logger'
import { validateHandle } from '../validation'

interface UseSettingsHandlersProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'warning' | 'info') => void
  showConfirm: (title: string, message: string) => Promise<boolean>
  t: (key: string, ...args: unknown[]) => string
}

export function useSettingsHandlers({ showToast, showConfirm, t }: UseSettingsHandlersProps) {
  const router = useRouter()
  const submittingRef = useRef(false)

  // Profile data
  const [handle, setHandle] = useState('')
  const [bio, setBio] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null)

  // Image cropper state
  const [showAvatarCropper, setShowAvatarCropper] = useState(false)
  const [showCoverCropper, setShowCoverCropper] = useState(false)
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null)

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
  const [hapticEnabled, setHapticEnabled] = useState(true)

  // Privacy settings
  const [showFollowers, setShowFollowers] = useState(true)
  const [showFollowing, setShowFollowing] = useState(true)
  const [dmPermission, setDmPermission] = useState<'all' | 'mutual' | 'none'>('all')
  const [showProBadge, setShowProBadge] = useState(true)

  // 2FA state
  const [twoFAEnabled, setTwoFAEnabled] = useState(false)
  const [twoFASetupData, setTwoFASetupData] = useState<{ qrCodeDataUrl: string; secret: string } | null>(null)
  const [twoFACode, setTwoFACode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [twoFALoading, setTwoFALoading] = useState(false)
  const [disablePassword, setDisablePassword] = useState('')
  const [showDisable2FA, setShowDisable2FA] = useState(false)

  // Sessions state
  interface SessionInfo {
    id: string
    deviceInfo: { browser?: string; os?: string } | null
    ipAddress: string | null
    lastActiveAt: string | null
    isCurrent: boolean
  }
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)

  // Blocked users state
  interface BlockedUserInfo {
    blockedId: string
    handle: string | null
    avatarUrl: string | null
    createdAt: string
  }
  const [blockedUsers, setBlockedUsers] = useState<BlockedUserInfo[]>([])
  const [loadingBlockedUsers, setLoadingBlockedUsers] = useState(false)
  const [unblockingId, setUnblockingId] = useState<string | null>(null)

  // Email digest state
  const [emailDigest, setEmailDigest] = useState<'none' | 'daily' | 'weekly'>('none')

  // Account deletion state
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteReason, setDeleteReason] = useState('')
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Handle uniqueness check
  const [handleAvailable, setHandleAvailable] = useState<boolean | null>(null)
  const [checkingHandle, setCheckingHandle] = useState(false)
  const handleCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Auth state
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Validation state
  const [touchedFields, setTouchedFields] = useState<{
    handle: boolean
    newPassword: boolean
    confirmPassword: boolean
    newEmail: boolean
  }>({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })

  const handleValidation = validateHandle(handle, t)

  const markTouched = useCallback((field: keyof typeof touchedFields) => {
    setTouchedFields(prev => ({ ...prev, [field]: true }))
  }, [])

  // ===== Debounced handle uniqueness check =====
  useEffect(() => {
    if (!handle || handle.length < 2 || !validateHandle(handle, t).valid) {
      setHandleAvailable(null)
      return
    }
    if (initialValuesRef.current && handle === initialValuesRef.current.handle) {
      setHandleAvailable(null)
      return
    }

    if (handleCheckTimeoutRef.current) clearTimeout(handleCheckTimeoutRef.current)
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

    return () => { if (handleCheckTimeoutRef.current) clearTimeout(handleCheckTimeoutRef.current) }
  }, [handle, userId, t])

  // ===== Check unsaved changes =====
  const hasUnsavedChanges = useCallback(() => {
    if (!initialValuesRef.current) return false
    const initial = initialValuesRef.current
    return (
      handle !== initial.handle || bio !== initial.bio ||
      avatarFile !== null || coverFile !== null ||
      notifyFollow !== initial.notifyFollow || notifyLike !== initial.notifyLike ||
      notifyComment !== initial.notifyComment || notifyMention !== initial.notifyMention ||
      notifyMessage !== initial.notifyMessage || showFollowers !== initial.showFollowers ||
      showFollowing !== initial.showFollowing || dmPermission !== initial.dmPermission ||
      showProBadge !== initial.showProBadge
    )
  }, [handle, bio, avatarFile, coverFile, notifyFollow, notifyLike, notifyComment, notifyMention, notifyMessage, showFollowers, showFollowing, dmPermission, showProBadge])

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  // ===== Reset countdown timer =====
  useEffect(() => {
    if (resetCountdown > 0) {
      const timer = setTimeout(() => setResetCountdown(resetCountdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [resetCountdown])

  // ===== Data loading functions =====
  const loadProfile = async (uid: string) => {
    try {
      setLoading(true)
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle, bio, avatar_url, cover_url, notify_follow, notify_like, notify_comment, notify_mention, notify_message, show_followers, show_following, dm_permission, show_pro_badge, totp_enabled, email_digest')
        .eq('id', uid)
        .maybeSingle()

      if (userProfile) {
        const p = {
          handle: userProfile.handle || '',
          bio: userProfile.bio || '',
          avatarUrl: userProfile.avatar_url || null,
          coverUrl: userProfile.cover_url || null,
          notifyFollow: userProfile.notify_follow !== false,
          notifyLike: userProfile.notify_like !== false,
          notifyComment: userProfile.notify_comment !== false,
          notifyMention: userProfile.notify_mention !== false,
          notifyMessage: userProfile.notify_message !== false,
          showFollowers: userProfile.show_followers !== false,
          showFollowing: userProfile.show_following !== false,
          dmPermission: userProfile.dm_permission || 'all',
          showProBadge: userProfile.show_pro_badge !== false,
        }

        setHandle(p.handle)
        setBio(p.bio)
        setAvatarUrl(p.avatarUrl)
        setPreviewUrl(p.avatarUrl)
        setCoverUrl(p.coverUrl)
        setCoverPreviewUrl(p.coverUrl)
        setTwoFAEnabled(userProfile.totp_enabled === true)
        setEmailDigest((userProfile.email_digest as 'none' | 'daily' | 'weekly') || 'none')
        setNotifyFollow(p.notifyFollow)
        setNotifyLike(p.notifyLike)
        setNotifyComment(p.notifyComment)
        setNotifyMention(p.notifyMention)
        setNotifyMessage(p.notifyMessage)
        setShowFollowers(p.showFollowers)
        setShowFollowing(p.showFollowing)
        setDmPermission(p.dmPermission as 'all' | 'mutual' | 'none')
        setShowProBadge(p.showProBadge)

        initialValuesRef.current = p
      }
    } catch (error) {
      uiLogger.error('Error loading profile:', error)
    } finally {
      setLoading(false)
    }
  }

  // ===== Image handlers =====
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 5 * 1024 * 1024) { showToast(t('imageSizeExceed').replace('{size}', '5'), 'error'); return }
      const reader = new FileReader()
      reader.onloadend = () => { setCropImageSrc(reader.result as string); setShowAvatarCropper(true) }
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  const handleAvatarCropComplete = (croppedBlob: Blob) => {
    try {
      setAvatarFile(new File([croppedBlob], 'avatar.jpg', { type: 'image/jpeg' }))
      setPreviewUrl(URL.createObjectURL(croppedBlob))
      setShowAvatarCropper(false)
      setCropImageSrc(null)
      showToast(t('cropSuccess') || 'Crop successful! Click Save to upload.', 'success')
    } catch (error) {
      logger.error('Error in handleAvatarCropComplete:', error)
      showToast(t('cropFailed') || 'Failed to process cropped image', 'error')
    }
  }

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 10 * 1024 * 1024) { showToast(t('imageSizeExceed').replace('{size}', '10'), 'error'); return }
      const reader = new FileReader()
      reader.onloadend = () => { setCropImageSrc(reader.result as string); setShowCoverCropper(true) }
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  const handleCoverCropComplete = (croppedBlob: Blob) => {
    try {
      setCoverFile(new File([croppedBlob], 'cover.jpg', { type: 'image/jpeg' }))
      setCoverPreviewUrl(URL.createObjectURL(croppedBlob))
      setShowCoverCropper(false)
      setCropImageSrc(null)
      showToast(t('cropSuccess') || 'Crop successful! Click Save to upload.', 'success')
    } catch (error) {
      logger.error('Error in handleCoverCropComplete:', error)
      showToast(t('cropFailed') || 'Failed to process cropped image', 'error')
    }
  }

  const handleRemoveCover = useCallback(() => {
    setCoverFile(null)
    setCoverPreviewUrl(null)
    setCoverUrl(null)
    showToast(t('coverRemoveHint'), 'info')
  }, [showToast, t])

  // ===== Upload helper =====
  const uploadFile = async (file: File, bucket: string, uid: string, maxSize: number): Promise<string | null> => {
    try {
      if (file.size > maxSize) { showToast(t('imageSizeExceed').replace('{size}', String(Math.round(maxSize / 1024 / 1024))), 'error'); return null }
      const fileExt = file.name.split('.').pop()?.toLowerCase()
      if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt || '')) { showToast(t('onlySupportFormats'), 'error'); return null }

      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', uid)
      formData.append('bucket', bucket)

      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch('/api/upload-profile-image', {
        method: 'POST',
        body: formData,
        headers: session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {},
      })
      const result = await response.json()
      if (!response.ok) { uiLogger.error(`${bucket} upload error:`, result.error); showToast(result.error || t('uploadFailed'), 'error'); return null }
      return result.url
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : t('unknownError')
      showToast(`${t('uploadException')}: ${errorMessage}`, 'error')
      return null
    }
  }

  // ===== Save profile =====
  const handleSaveProfile = async () => {
    if (submittingRef.current || saving || !userId) return
    if (handle && !handleValidation.valid) { showToast(handleValidation.message, 'error'); return }
    if (handle && handleAvailable === false) { showToast(t('usernameInUse'), 'error'); return }

    // Server-side bio length validation
    if (bio && bio.length > 200) {
      showToast(t('bioTooLong') || 'Bio must be 200 characters or less', 'error')
      return
    }

    submittingRef.current = true
    setSaving(true)
    try {
      const { data: currentProfile } = await supabase
        .from('user_profiles')
        .select('avatar_url, cover_url')
        .eq('id', userId)
        .maybeSingle()

      let finalAvatarUrl = avatarUrl
      let finalCoverUrl = coverUrl
      let uploadFailed = false

      if (avatarFile) {
        const uploadedUrl = await uploadFile(avatarFile, 'avatars', userId, 5 * 1024 * 1024)
        if (uploadedUrl) { finalAvatarUrl = uploadedUrl; setAvatarUrl(uploadedUrl); setPreviewUrl(uploadedUrl) }
        else { uploadFailed = true; setAvatarFile(null); if (currentProfile?.avatar_url) { finalAvatarUrl = currentProfile.avatar_url; setPreviewUrl(currentProfile.avatar_url) } else setPreviewUrl(null) }
      }

      if (coverFile) {
        const uploadedUrl = await uploadFile(coverFile, 'covers', userId, 10 * 1024 * 1024)
        if (uploadedUrl) { finalCoverUrl = uploadedUrl; setCoverUrl(uploadedUrl); setCoverPreviewUrl(uploadedUrl) }
        else { uploadFailed = true; setCoverFile(null); if (currentProfile?.cover_url) { finalCoverUrl = currentProfile.cover_url; setCoverPreviewUrl(currentProfile.cover_url) } else setCoverPreviewUrl(null) }
      }

      const { error: saveError } = await supabase
        .from('user_profiles')
        .update({
          handle: handle || null, bio: bio || null,
          avatar_url: finalAvatarUrl || null, cover_url: finalCoverUrl || null,
          notify_follow: notifyFollow, notify_like: notifyLike, notify_comment: notifyComment,
          notify_mention: notifyMention, notify_message: notifyMessage,
          show_followers: showFollowers, show_following: showFollowing,
          dm_permission: dmPermission, show_pro_badge: showProBadge,
        })
        .eq('id', userId)

      if (saveError) {
        uiLogger.error('Error saving profile:', JSON.stringify(saveError, null, 2))
        if (saveError.code === '23505' || saveError.message?.includes('unique') || saveError.message?.includes('duplicate')) {
          showToast(t('usernameInUse'), 'error')
        } else {
          showToast(t('saveFailedWithMsg').replace('{msg}', saveError.message || ''), 'error')
        }
        return
      }

      initialValuesRef.current = {
        handle, bio, avatarUrl: finalAvatarUrl, coverUrl: finalCoverUrl,
        notifyFollow, notifyLike, notifyComment, notifyMention, notifyMessage,
        showFollowers, showFollowing, dmPermission, showProBadge,
      }
      setAvatarFile(null)
      setCoverFile(null)

      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          await fetch('/api/revalidate/profile', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } })
        }
      } catch (revalidateError) {
        logger.warn('[Settings] Failed to revalidate profile cache:', revalidateError)
      }

      showToast(uploadFailed ? t('settingsPartialSaved') : t('settingsSaved'), uploadFailed ? 'warning' : 'success')
      router.refresh()
    } catch (error) {
      uiLogger.error('Error saving:', error)
      showToast(t('saveFailedRetry'), 'error')
    } finally {
      setSaving(false)
      submittingRef.current = false
    }
  }

  // ===== Auth handlers =====
  const getFreshToken = async (): Promise<string | null> => {
    const { data: { session }, error } = await supabase.auth.refreshSession()
    if (error || !session?.access_token) {
      const { data } = await supabase.auth.getSession()
      return data.session?.access_token || null
    }
    return session.access_token
  }

  const handleSendResetCode = async () => {
    if (submittingRef.current || sendingResetCode || !email) return
    submittingRef.current = true
    setSendingResetCode(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` })
      if (error) { showToast(error.message, 'error'); return }
      setResetCodeSent(true)
      setResetCountdown(60)
      showToast(t('resetEmailSent'), 'success')
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : t('sendFailed'), 'error')
    } finally { setSendingResetCode(false); submittingRef.current = false }
  }

  const handleChangePassword = async () => {
    if (submittingRef.current || savingPassword || !currentPassword || !email) return
    submittingRef.current = true
    setSavingPassword(true)
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: currentPassword })
      if (signInError) { showToast(t('currentPasswordWrong'), 'error'); return }
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) { showToast(error.message, 'error'); return }
      // After password change, revoke all other sessions to kick out other devices
      try {
        const { data: { session: currentSession } } = await supabase.auth.getSession()
        if (currentSession?.access_token) {
          await fetch('/api/settings/sessions', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentSession.access_token}` },
            body: JSON.stringify({ all: true }),
          })
        }
      } catch (revokeErr) {
        // Non-critical: password was changed even if session revocation fails
        uiLogger.warn('[ChangePassword] Failed to revoke other sessions:', revokeErr)
      }
      showToast(t('passwordChanged'), 'success')
      setCurrentPassword(''); setNewPassword(''); setConfirmNewPassword('')
      setTouchedFields(prev => ({ ...prev, newPassword: false, confirmPassword: false }))
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : t('changeFailed'), 'error')
    } finally { setSavingPassword(false); submittingRef.current = false }
  }

  const handleChangeEmail = async () => {
    if (submittingRef.current || savingEmail || !newEmail) return
    // Basic server-side email format validation before calling Supabase Auth
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(newEmail.trim())) {
      showToast(t('invalidEmailFormat') || 'Invalid email format', 'error')
      return
    }
    submittingRef.current = true
    setSavingEmail(true)
    try {
      const { error } = await supabase.auth.updateUser({ email: newEmail.trim() })
      if (error) { showToast(error.message, 'error'); return }
      showToast(t('verificationEmailSent'), 'success')
      setNewEmail('')
      setTouchedFields(prev => ({ ...prev, newEmail: false }))
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : t('changeFailed'), 'error')
    } finally { setSavingEmail(false); submittingRef.current = false }
  }

  // ===== 2FA handlers =====
  const handleSetup2FA = async () => {
    if (submittingRef.current || twoFALoading) return
    submittingRef.current = true
    setTwoFALoading(true)
    try {
      const token = await getFreshToken()
      if (!token) { showToast(t('pleaseLoginFirst'), 'error'); return }
      const res = await fetch('/api/settings/2fa/setup', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || t('operationFailed'), 'error'); return }
      setTwoFASetupData({ qrCodeDataUrl: data.qrCode, secret: data.secret })
    } catch { showToast(t('networkError'), 'error') }
    finally { setTwoFALoading(false); submittingRef.current = false }
  }

  const handleVerify2FA = async () => {
    if (submittingRef.current || twoFALoading || !twoFACode || twoFACode.length !== 6) return
    submittingRef.current = true
    setTwoFALoading(true)
    try {
      const token = await getFreshToken()
      if (!token) { showToast(t('pleaseLoginFirst'), 'error'); return }
      const res = await fetch('/api/settings/2fa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: twoFACode }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || t('verificationFailed'), 'error'); return }
      setTwoFAEnabled(true); setBackupCodes(data.backupCodes || []); setTwoFASetupData(null); setTwoFACode('')
      showToast(t('twoFAEnabled'), 'success')
    } catch { showToast(t('networkError'), 'error') }
    finally { setTwoFALoading(false); submittingRef.current = false }
  }

  const handleDisable2FA = async () => {
    if (submittingRef.current || twoFALoading || !disablePassword) return
    submittingRef.current = true
    setTwoFALoading(true)
    try {
      const token = await getFreshToken()
      if (!token) { showToast(t('pleaseLoginFirst'), 'error'); return }
      const res = await fetch('/api/settings/2fa/disable', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: disablePassword }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || t('closeFailed'), 'error'); return }
      setTwoFAEnabled(false); setShowDisable2FA(false); setDisablePassword(''); setBackupCodes([])
      showToast(t('twoFADisabled'), 'success')
    } catch { showToast(t('networkError'), 'error') }
    finally { setTwoFALoading(false); submittingRef.current = false }
  }

  // ===== Sessions handlers =====
  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setLoadingSessions(false); return }
      const res = await fetch('/api/settings/sessions', { headers: { Authorization: `Bearer ${session.access_token}` } })
      if (res.ok) {
        const data = await res.json()
        const sessionList = (data.sessions || []) as Array<{ id: string; deviceInfo: string | null; ipAddress: string | null; lastActiveAt: string | null }>
        setSessions(sessionList.map((s, index) => ({
          id: s.id,
          deviceInfo: s.deviceInfo ? (typeof s.deviceInfo === 'string' ? JSON.parse(s.deviceInfo) : s.deviceInfo) as { browser?: string; os?: string } : null,
          ipAddress: s.ipAddress, lastActiveAt: s.lastActiveAt, isCurrent: index === 0,
        })))
      }
    } catch (error) { uiLogger.error('[Sessions] Load error:', error) }
    finally { setLoadingSessions(false) }
  }, [])

  const handleRevokeSession = async (sessionId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch('/api/settings/sessions', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ sessionId }),
      })
      if (res.ok) { setSessions(prev => prev.filter(s => s.id !== sessionId)); showToast(t('sessionRevoked'), 'success') }
      else showToast(t('operationFailed'), 'error')
    } catch { showToast(t('networkError'), 'error') }
  }

  const handleRevokeAllSessions = async () => {
    const confirmed = await showConfirm(t('logoutAllDevices'), t('logoutAllDevicesConfirm'))
    if (!confirmed) return
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch('/api/settings/sessions', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ all: true }),
      })
      if (res.ok) { setSessions(prev => prev.filter(s => s.isCurrent)); showToast(t('logoutAllSuccess'), 'success') }
      else showToast(t('operationFailed'), 'error')
    } catch { showToast(t('networkError'), 'error') }
  }

  // ===== Blocked users handlers =====
  const loadBlockedUsers = useCallback(async (uid: string) => {
    setLoadingBlockedUsers(true)
    try {
      const { data: blockedRows, error } = await supabase.from('blocked_users').select('blocked_id, created_at').eq('blocker_id', uid)
      if (error || !blockedRows || blockedRows.length === 0) { setBlockedUsers([]); return }
      const blockedIds = blockedRows.map(r => r.blocked_id as string)
      const { data: profiles } = await supabase.from('user_profiles').select('id, handle, avatar_url').in('id', blockedIds)
      const profileMap = new Map((profiles || []).map(p => [p.id as string, p]))
      setBlockedUsers(blockedRows.map(row => {
        const profile = profileMap.get(row.blocked_id as string)
        return { blockedId: row.blocked_id as string, handle: (profile?.handle as string) || null, avatarUrl: (profile?.avatar_url as string) || null, createdAt: row.created_at as string }
      }))
    } catch (error) { uiLogger.error('[BlockedUsers] Load error:', error) }
    finally { setLoadingBlockedUsers(false) }
  }, [])

  const handleUnblock = async (blockedId: string) => {
    setUnblockingId(blockedId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch(`/api/users/${blockedId}/block`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } })
      if (res.ok) { setBlockedUsers(prev => prev.filter(u => u.blockedId !== blockedId)); showToast(t('unblocked'), 'success') }
      else showToast(t('operationFailed'), 'error')
    } catch { showToast(t('networkError'), 'error') }
    finally { setUnblockingId(null) }
  }

  // ===== Email digest handler =====
  const handleEmailDigestChange = async (value: 'none' | 'daily' | 'weekly') => {
    if (!userId) return
    const previous = emailDigest
    setEmailDigest(value)
    try {
      const { error } = await supabase.from('user_profiles').update({ email_digest: value }).eq('id', userId)
      if (error) { setEmailDigest(previous); showToast(t('saveFailed'), 'error'); return }
      showToast(t('emailDigestSaved'), 'success')
    } catch { setEmailDigest(previous); showToast(t('saveFailed'), 'error') }
  }

  // ===== Account handlers =====
  const handleLogout = async () => {
    const confirmed = await showConfirm(t('logoutTitle'), t('logoutConfirm'))
    if (!confirmed) return
    try {
      const { clearProStatusCache } = await import('@/lib/hooks/useProStatus')
      clearProStatusCache()
      try { sessionStorage.clear() } catch { /* ignore */ }
      try { localStorage.removeItem('guest-signup-dismissed') } catch { /* ignore */ }
      await supabase.auth.signOut()
      router.push('/')
    } catch { showToast(t('logoutFailed'), 'error') }
  }

  const handleDeleteAccount = async () => {
    if (!deletePassword) return
    setDeletingAccount(true); setDeleteError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setDeleteError(t('pleaseLoginAgain')); return }
      const res = await fetch('/api/account/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ password: deletePassword, reason: deleteReason }),
      })
      const data = await res.json()
      if (!res.ok) { setDeleteError(data.error || t('operationFailed')); return }
      showToast(t('accountMarkedDeleted'), 'success')
      setShowDeleteAccountModal(false)
      await supabase.auth.signOut()
      router.push('/')
    } catch { setDeleteError(t('networkErrorRetry')) }
    finally { setDeletingAccount(false) }
  }

  // ===== Notification toggle auto-save =====
  const handleNotificationToggleSave = useCallback(async (field: string, value: boolean) => {
    if (!userId) return
    try {
      const { error } = await supabase.from('user_profiles').update({ [field]: value }).eq('id', userId)
      if (error) { showToast(t('saveFailed'), 'error'); return }
      showToast(t('settingsSaved'), 'success')
      if (initialValuesRef.current) {
        const camelKey = field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
        if (camelKey in initialValuesRef.current) {
          (initialValuesRef.current as Record<string, unknown>)[camelKey] = value
        }
      }
    } catch { showToast(t('saveFailed'), 'error') }
  }, [userId, showToast, t])

  return {
    // Auth state
    email, setEmail, userId, setUserId, loading, saving,

    // Profile state
    handle, setHandle, bio, setBio,
    previewUrl, coverPreviewUrl, coverUrl,
    handleAvailable, checkingHandle,
    initialValuesRef,

    // Image cropper
    showAvatarCropper, showCoverCropper, cropImageSrc,
    setShowAvatarCropper, setShowCoverCropper, setCropImageSrc,

    // Validation
    touchedFields, markTouched, handleValidation,

    // Password
    currentPassword, setCurrentPassword,
    newPassword, setNewPassword,
    confirmNewPassword, setConfirmNewPassword,
    savingPassword, passwordResetMode, setPasswordResetMode,
    resetCodeSent, sendingResetCode, resetCountdown,
    savingEmail, newEmail, setNewEmail,

    // 2FA
    twoFAEnabled, twoFASetupData, twoFACode, setTwoFACode,
    backupCodes, twoFALoading,
    showDisable2FA, setShowDisable2FA,
    disablePassword, setDisablePassword,

    // Sessions
    sessions, loadingSessions,

    // Notifications
    notifyFollow, setNotifyFollow,
    notifyLike, setNotifyLike,
    notifyComment, setNotifyComment,
    notifyMention, setNotifyMention,
    notifyMessage, setNotifyMessage,
    hapticEnabled, setHapticEnabled,
    emailDigest,

    // Privacy
    showFollowers, setShowFollowers,
    showFollowing, setShowFollowing,
    dmPermission, setDmPermission,
    showProBadge, setShowProBadge,

    // Blocked users
    blockedUsers, loadingBlockedUsers, unblockingId,

    // Delete account
    showDeleteAccountModal, setShowDeleteAccountModal,
    deletePassword, setDeletePassword,
    deleteReason, setDeleteReason,
    deletingAccount, deleteError,

    // Handlers
    loadProfile, hasUnsavedChanges,
    handleAvatarChange, handleAvatarCropComplete,
    handleCoverChange, handleCoverCropComplete, handleRemoveCover,
    handleSaveProfile,
    handleSendResetCode, handleChangePassword, handleChangeEmail,
    handleSetup2FA, handleVerify2FA, handleDisable2FA,
    loadSessions, handleRevokeSession, handleRevokeAllSessions,
    loadBlockedUsers, handleUnblock,
    handleEmailDigestChange,
    handleLogout, handleDeleteAccount,
    handleNotificationToggleSave,

    // For resetting
    setAvatarFile, setCoverFile, setHandleAvailable,
    setTouchedFields,
  }
}
