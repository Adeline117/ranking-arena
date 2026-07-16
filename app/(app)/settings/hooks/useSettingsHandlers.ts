'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { uiLogger } from '@/lib/utils/logger'
import { logger } from '@/lib/logger'
import { authedFetch, getCsrfHeaders } from '@/lib/api/client'
import { validateHandle } from '../validation'
import { isHapticsEnabled } from '@/lib/utils/haptics'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  EMAIL_DIGEST_VALUES,
  type EmailDigestValue,
  NOTIFICATION_PREFERENCE_INITIAL_KEYS,
  type NotificationPreferenceField,
} from '@/lib/profile/notification-preferences'
import { NotificationPreferenceQueue } from '@/lib/profile/notification-preference-queue'
import { LatestWriteQueue } from '@/lib/profile/latest-write-queue'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from './settings-viewer-scope'

type NotificationWriteContext = {
  accessToken: string
  userId: string
  sessionGeneration: number
}

type ProfileLoadOutcome = Pick<
  SettingsViewerSnapshot,
  'sessionGeneration' | 'userId' | 'viewerKey'
> & {
  status: 'loading' | 'ready' | 'failed'
}

type SettingsStateOwner = SettingsViewerSnapshot & {
  profileGeneration: number
}

function settingsScopeMatches(
  left: Pick<SettingsViewerSnapshot, 'sessionGeneration' | 'userId' | 'viewerKey'>,
  right: Pick<SettingsViewerSnapshot, 'sessionGeneration' | 'userId' | 'viewerKey'>
): boolean {
  return (
    left.viewerKey === right.viewerKey &&
    left.sessionGeneration === right.sessionGeneration &&
    left.userId === right.userId
  )
}

interface UseSettingsHandlersProps {
  auth: AuthSessionReturn
  showToast: (msg: string, type?: 'success' | 'error' | 'warning' | 'info') => void
  showConfirm: (title: string, message: string) => Promise<boolean>
  t: (key: string, ...args: unknown[]) => string
}

export function useSettingsHandlers({ auth, showToast, showConfirm, t }: UseSettingsHandlersProps) {
  const router = useRouter()
  const submittingRef = useRef(false)
  const profileLoadGenerationRef = useRef(0)
  const authRef = useRef(auth)
  authRef.current = auth

  const captureViewer = useCallback(() => captureSettingsViewer(authRef.current), [])
  const viewerIsCurrent = useCallback(
    (snapshot: SettingsViewerSnapshot) => isSettingsViewerCurrent(snapshot, authRef.current),
    []
  )
  const settingsStateOwnerRef = useRef<SettingsStateOwner | null>(null)
  const profileLoadOutcomeRef = useRef<ProfileLoadOutcome | null>(null)
  const stateBelongsToViewer = useCallback(
    (snapshot: SettingsViewerSnapshot, expectedProfileGeneration?: number) => {
      const owner = settingsStateOwnerRef.current
      return (
        !!owner &&
        owner.profileGeneration === profileLoadGenerationRef.current &&
        (expectedProfileGeneration === undefined ||
          owner.profileGeneration === expectedProfileGeneration) &&
        settingsScopeMatches(owner, snapshot) &&
        viewerIsCurrent(snapshot)
      )
    },
    [viewerIsCurrent]
  )

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
    notifyTraderEvents: boolean
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
  const [notifyTraderEvents, setNotifyTraderEvents] = useState(true)
  const notificationFeedbackRef = useRef({ showToast, t })
  notificationFeedbackRef.current = { showToast, t }
  const notificationQueueRef = useRef<NotificationPreferenceQueue<NotificationWriteContext> | null>(
    null
  )
  if (!notificationQueueRef.current) {
    notificationQueueRef.current = new NotificationPreferenceQueue<NotificationWriteContext>({
      write: async (field, value, context) => {
        const result = await authedFetch<{ success?: unknown }>(
          '/api/profile/notification-preferences',
          'PATCH',
          context.accessToken,
          { field, value },
          15_000,
          {
            expectedUserId: context.userId,
            expectedSessionGeneration: context.sessionGeneration,
          }
        )
        if (result.stale) return 'stale'
        return result.ok && result.data?.success === true ? 'saved' : 'failed'
      },
      onPersisted: (field, value) => {
        if (initialValuesRef.current) {
          initialValuesRef.current[NOTIFICATION_PREFERENCE_INITIAL_KEYS[field]] = value
        }
      },
      onFailed: () => {
        const feedback = notificationFeedbackRef.current
        feedback.showToast(feedback.t('saveFailed'), 'error')
      },
      onSaved: () => {
        const feedback = notificationFeedbackRef.current
        feedback.showToast(feedback.t('settingsSaved'), 'success')
      },
    })
  }
  const emailDigestPersistedRef = useRef<EmailDigestValue>('none')
  const emailDigestQueueRef = useRef<LatestWriteQueue<
    'email_digest',
    EmailDigestValue,
    NotificationWriteContext
  > | null>(null)
  if (!emailDigestQueueRef.current) {
    emailDigestQueueRef.current = new LatestWriteQueue({
      write: async (_field, value, context) => {
        const result = await authedFetch<{ success?: unknown }>(
          '/api/profile/notification-preferences',
          'PATCH',
          context.accessToken,
          { field: 'email_digest', value },
          15_000,
          {
            expectedUserId: context.userId,
            expectedSessionGeneration: context.sessionGeneration,
          }
        )
        if (result.stale) return 'stale'
        return result.ok && result.data?.success === true ? 'saved' : 'failed'
      },
      onPersisted: (_field, value) => {
        emailDigestPersistedRef.current = value
      },
      onFailed: () => {
        const feedback = notificationFeedbackRef.current
        feedback.showToast(feedback.t('saveFailed'), 'error')
      },
      onSaved: () => {
        const feedback = notificationFeedbackRef.current
        feedback.showToast(feedback.t('emailDigestSaved'), 'success')
      },
    })
  }
  // 初值从持久化偏好读(2026-07-11);SSR 返回 true,客户端首渲染再校正
  const [hapticEnabled, setHapticEnabled] = useState(() => isHapticsEnabled())

  // Privacy settings
  const [showFollowers, setShowFollowers] = useState(true)
  const [showFollowing, setShowFollowing] = useState(true)
  const [dmPermission, setDmPermission] = useState<'all' | 'mutual' | 'none'>('all')
  const [showProBadge, setShowProBadge] = useState(true)

  // 2FA state
  const [twoFAEnabled, setTwoFAEnabled] = useState(false)
  const [twoFASetupData, setTwoFASetupData] = useState<{
    qrCodeDataUrl: string
    secret: string
  } | null>(null)
  const [twoFACode, setTwoFACode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [twoFALoading, setTwoFALoading] = useState(false)
  const [disablePassword, setDisablePassword] = useState('')
  const [showDisable2FA, setShowDisable2FA] = useState(false)

  // Passkey (WebAuthn) state
  interface PasskeyInfo {
    id: string
    deviceName: string | null
    createdAt: string
    lastUsedAt: string | null
    transports: string[]
  }
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([])
  const [loadingPasskeys, setLoadingPasskeys] = useState(false)
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [newPasskeyName, setNewPasskeyName] = useState('')

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
  const [emailDigest, setEmailDigest] = useState<EmailDigestValue>('none')

  // Account deletion state
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteReason, setDeleteReason] = useState('')
  const [deletingAccount, setDeletingAccount] = useState(false)
  // 2026-07-11:OAuth/钱包用户无密码,删号改键入 DELETE 确认(server 同逻辑)。
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteHasPassword, setDeleteHasPassword] = useState(true) // 默认 true(email/password)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Handle uniqueness check
  const [handleAvailable, setHandleAvailable] = useState<boolean | null>(null)
  const [checkingHandle, setCheckingHandle] = useState(false)
  const handleCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const handleCheckGenerationRef = useRef(0)
  const passkeyLoadGenerationRef = useRef(0)
  const sessionLoadGenerationRef = useRef(0)
  const blockedUsersLoadGenerationRef = useRef(0)

  // Profile readiness is separate from canonical authentication. A failed
  // sensitive read must never turn into writable client-side defaults.
  const [profileReady, setProfileReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const userId = auth.userId
  const email = auth.email

  useEffect(() => {
    notificationQueueRef.current?.invalidate()
    emailDigestQueueRef.current?.invalidate()
  }, [auth.sessionGeneration, auth.userId])

  // Validation state
  const [touchedFields, setTouchedFields] = useState<{
    handle: boolean
    newPassword: boolean
    confirmPassword: boolean
    newEmail: boolean
  }>({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })

  const handleValidation = validateHandle(handle, t)

  const markTouched = useCallback((field: keyof typeof touchedFields) => {
    setTouchedFields((prev) => ({ ...prev, [field]: true }))
  }, [])

  // ===== Debounced handle uniqueness check =====
  useEffect(() => {
    const generation = ++handleCheckGenerationRef.current
    if (handleCheckTimeoutRef.current) clearTimeout(handleCheckTimeoutRef.current)

    if (!handle || handle.length < 2 || !validateHandle(handle, t).valid) {
      setHandleAvailable(null)
      setCheckingHandle(false)
      return
    }
    if (initialValuesRef.current && handle === initialValuesRef.current.handle) {
      setHandleAvailable(null)
      setCheckingHandle(false)
      return
    }

    setCheckingHandle(true)
    handleCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const scope = captureViewer()
        if (!scope || !stateBelongsToViewer(scope) || scope.userId !== userId) {
          if (handleCheckGenerationRef.current === generation) setHandleAvailable(null)
          return
        }
        const result = await authedFetch<{ available?: unknown }>(
          '/api/profile/handle-availability',
          'POST',
          scope.accessToken,
          { handle },
          15_000,
          {
            expectedUserId: scope.userId,
            expectedSessionGeneration: scope.sessionGeneration,
          }
        )
        if (handleCheckGenerationRef.current !== generation || !viewerIsCurrent(scope)) return
        if (result.stale || !result.ok || typeof result.data?.available !== 'boolean') {
          setHandleAvailable(null)
          return
        }
        setHandleAvailable(result.data.available)
      } catch {
        if (handleCheckGenerationRef.current === generation) setHandleAvailable(null)
      } finally {
        if (handleCheckGenerationRef.current === generation) setCheckingHandle(false)
      }
    }, 500)

    return () => {
      if (handleCheckTimeoutRef.current) clearTimeout(handleCheckTimeoutRef.current)
      if (handleCheckGenerationRef.current === generation) {
        handleCheckGenerationRef.current += 1
      }
    }
  }, [
    auth.accessToken,
    auth.sessionGeneration,
    auth.userId,
    captureViewer,
    handle,
    profileReady,
    stateBelongsToViewer,
    t,
    userId,
    viewerIsCurrent,
  ])

  // ===== Check unsaved changes =====
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
      notifyTraderEvents !== initial.notifyTraderEvents ||
      showFollowers !== initial.showFollowers ||
      showFollowing !== initial.showFollowing ||
      dmPermission !== initial.dmPermission ||
      showProBadge !== initial.showProBadge
    )
  }, [
    handle,
    bio,
    avatarFile,
    coverFile,
    notifyFollow,
    notifyLike,
    notifyComment,
    notifyMention,
    notifyMessage,
    notifyTraderEvents,
    showFollowers,
    showFollowing,
    dmPermission,
    showProBadge,
  ])

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

  // ===== Reset countdown timer =====
  useEffect(() => {
    if (resetCountdown > 0) {
      const timer = setTimeout(() => setResetCountdown(resetCountdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [resetCountdown])

  // ===== Data loading functions =====
  const resetViewerState = useCallback((authPending: boolean) => {
    if (handleCheckTimeoutRef.current) clearTimeout(handleCheckTimeoutRef.current)
    handleCheckGenerationRef.current += 1
    profileLoadGenerationRef.current += 1
    passkeyLoadGenerationRef.current += 1
    sessionLoadGenerationRef.current += 1
    blockedUsersLoadGenerationRef.current += 1
    notificationQueueRef.current?.invalidate()
    emailDigestQueueRef.current?.invalidate()
    settingsStateOwnerRef.current = null
    profileLoadOutcomeRef.current = null

    setHandle('')
    setBio('')
    setAvatarUrl(null)
    setAvatarFile(null)
    setPreviewUrl(null)
    setCoverUrl(null)
    setCoverFile(null)
    setCoverPreviewUrl(null)
    setShowAvatarCropper(false)
    setShowCoverCropper(false)
    setCropImageSrc(null)
    initialValuesRef.current = null

    setCurrentPassword('')
    setNewPassword('')
    setConfirmNewPassword('')
    setSavingPassword(false)
    setPasswordResetMode('password')
    setResetCodeSent(false)
    setSendingResetCode(false)
    setResetCountdown(0)
    setNewEmail('')
    setSavingEmail(false)

    setNotifyFollow(true)
    setNotifyLike(true)
    setNotifyComment(true)
    setNotifyMention(true)
    setNotifyMessage(true)
    setNotifyTraderEvents(true)
    setShowFollowers(true)
    setShowFollowing(true)
    setDmPermission('all')
    setShowProBadge(true)

    setTwoFAEnabled(false)
    setTwoFASetupData(null)
    setTwoFACode('')
    setBackupCodes([])
    setTwoFALoading(false)
    setDisablePassword('')
    setShowDisable2FA(false)

    setPasskeys([])
    setLoadingPasskeys(false)
    setPasskeyBusy(false)
    setNewPasskeyName('')
    setSessions([])
    setLoadingSessions(false)
    setBlockedUsers([])
    setLoadingBlockedUsers(false)
    setUnblockingId(null)

    setEmailDigest('none')
    emailDigestPersistedRef.current = 'none'
    setShowDeleteAccountModal(false)
    setDeletePassword('')
    setDeleteReason('')
    setDeletingAccount(false)
    setDeleteConfirm('')
    setDeleteHasPassword(true)
    setDeleteError(null)

    setHandleAvailable(null)
    setCheckingHandle(false)
    setTouchedFields({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })
    setProfileReady(false)
    setSaving(false)
    setLoading(authPending)
    submittingRef.current = false
  }, [])

  const loadProfile = useCallback(async () => {
    const scope = captureViewer()
    if (!scope) return
    const loadGeneration = ++profileLoadGenerationRef.current
    const loadIsCurrent = () =>
      profileLoadGenerationRef.current === loadGeneration && viewerIsCurrent(scope)

    try {
      settingsStateOwnerRef.current = null
      profileLoadOutcomeRef.current = { ...scope, status: 'loading' }
      notificationQueueRef.current?.invalidate()
      emailDigestQueueRef.current?.invalidate()
      setLoading(true)
      setProfileReady(false)
      // Safe columns via regular query + sensitive columns via SECURITY DEFINER RPC
      const [profileResult, sensitiveResult] = await Promise.all([
        supabase
          .from('user_profiles')
          .select(
            'handle, bio, avatar_url, cover_url, show_followers, show_following, dm_permission, show_pro_badge'
          )
          .eq('id', scope.userId)
          .maybeSingle(),
        supabase.rpc('get_own_profile_sensitive').maybeSingle(),
      ])
      if (!loadIsCurrent()) return

      if (
        profileResult.error ||
        !profileResult.data ||
        sensitiveResult.error ||
        !sensitiveResult.data
      ) {
        throw (
          profileResult.error ||
          sensitiveResult.error ||
          new Error('Profile provisioning is incomplete')
        )
      }

      const userProfile = profileResult.data
      const sensitive = sensitiveResult.data
      const digest = sensitive.email_digest
      if (
        typeof sensitive.notify_follow !== 'boolean' ||
        typeof sensitive.notify_like !== 'boolean' ||
        typeof sensitive.notify_comment !== 'boolean' ||
        typeof sensitive.notify_mention !== 'boolean' ||
        typeof sensitive.notify_message !== 'boolean' ||
        typeof sensitive.notify_trader_events !== 'boolean' ||
        typeof sensitive.totp_enabled !== 'boolean' ||
        !EMAIL_DIGEST_VALUES.includes(digest as EmailDigestValue)
      ) {
        throw new Error('Sensitive profile contract is incomplete')
      }

      const dmPermission: 'all' | 'mutual' | 'none' =
        userProfile.dm_permission === 'mutual' || userProfile.dm_permission === 'none'
          ? userProfile.dm_permission
          : 'all'
      const p = {
        handle: userProfile.handle || '',
        bio: userProfile.bio || '',
        avatarUrl: userProfile.avatar_url || null,
        coverUrl: userProfile.cover_url || null,
        notifyFollow: sensitive.notify_follow,
        notifyLike: sensitive.notify_like,
        notifyComment: sensitive.notify_comment,
        notifyMention: sensitive.notify_mention,
        notifyMessage: sensitive.notify_message,
        notifyTraderEvents: sensitive.notify_trader_events,
        showFollowers: userProfile.show_followers !== false,
        showFollowing: userProfile.show_following !== false,
        dmPermission,
        showProBadge: userProfile.show_pro_badge !== false,
      }

      if (!loadIsCurrent()) return
      setHandle(p.handle)
      setBio(p.bio)
      setAvatarUrl(p.avatarUrl)
      setPreviewUrl(p.avatarUrl)
      setCoverUrl(p.coverUrl)
      setCoverPreviewUrl(p.coverUrl)
      setTwoFAEnabled(sensitive.totp_enabled)
      setEmailDigest(digest as EmailDigestValue)
      emailDigestPersistedRef.current = digest as EmailDigestValue
      setNotifyFollow(p.notifyFollow)
      setNotifyLike(p.notifyLike)
      setNotifyComment(p.notifyComment)
      setNotifyMention(p.notifyMention)
      setNotifyMessage(p.notifyMessage)
      setNotifyTraderEvents(p.notifyTraderEvents)
      setShowFollowers(p.showFollowers)
      setShowFollowing(p.showFollowing)
      setDmPermission(p.dmPermission)
      setShowProBadge(p.showProBadge)
      initialValuesRef.current = p
      settingsStateOwnerRef.current = { ...scope, profileGeneration: loadGeneration }
      profileLoadOutcomeRef.current = { ...scope, status: 'ready' }
      setProfileReady(true)
    } catch (error) {
      if (!loadIsCurrent()) return
      uiLogger.error('Error loading profile:', error)
      settingsStateOwnerRef.current = null
      profileLoadOutcomeRef.current = { ...scope, status: 'failed' }
      initialValuesRef.current = null
      setProfileReady(false)
      showToast(t('saveFailedRetry'), 'error')
    } finally {
      if (loadIsCurrent()) setLoading(false)
    }
  }, [captureViewer, showToast, t, viewerIsCurrent])

  useEffect(() => {
    const authPending = auth.loading || !auth.authChecked
    resetViewerState(authPending)
    if (authPending || !auth.userId) return
    void loadProfile()
  }, [
    auth.authChecked,
    auth.loading,
    auth.sessionGeneration,
    auth.userId,
    loadProfile,
    resetViewerState,
  ])

  // ===== Image handlers =====
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    const profileGeneration = profileLoadGenerationRef.current
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        showToast(t('imageSizeExceed').replace('{size}', '5'), 'error')
        return
      }
      const reader = new FileReader()
      reader.onloadend = () => {
        if (!stateBelongsToViewer(scope, profileGeneration)) return
        setCropImageSrc(reader.result as string)
        setShowAvatarCropper(true)
      }
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  const handleAvatarCropComplete = (croppedBlob: Blob) => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    try {
      setAvatarFile(new File([croppedBlob], 'avatar.jpg', { type: 'image/jpeg' }))
      setPreviewUrl(URL.createObjectURL(croppedBlob))
      setShowAvatarCropper(false)
      setCropImageSrc(null)
      showToast(t('cropSuccess'), 'success')
    } catch (error) {
      logger.error('Error in handleAvatarCropComplete:', error)
      showToast(t('cropFailed'), 'error')
    }
  }

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    const profileGeneration = profileLoadGenerationRef.current
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        showToast(t('imageSizeExceed').replace('{size}', '10'), 'error')
        return
      }
      const reader = new FileReader()
      reader.onloadend = () => {
        if (!stateBelongsToViewer(scope, profileGeneration)) return
        setCropImageSrc(reader.result as string)
        setShowCoverCropper(true)
      }
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  const handleCoverCropComplete = (croppedBlob: Blob) => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    try {
      setCoverFile(new File([croppedBlob], 'cover.jpg', { type: 'image/jpeg' }))
      setCoverPreviewUrl(URL.createObjectURL(croppedBlob))
      setShowCoverCropper(false)
      setCropImageSrc(null)
      showToast(t('cropSuccess'), 'success')
    } catch (error) {
      logger.error('Error in handleCoverCropComplete:', error)
      showToast(t('cropFailed'), 'error')
    }
  }

  const handleRemoveCover = useCallback(() => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    setCoverFile(null)
    setCoverPreviewUrl(null)
    setCoverUrl(null)
    showToast(t('coverRemoveHint'), 'info')
  }, [captureViewer, showToast, stateBelongsToViewer, t])

  // ===== Upload helper =====
  const uploadFile = async (
    file: File,
    bucket: string,
    scope: SettingsViewerSnapshot,
    profileGeneration: number,
    maxSize: number
  ): Promise<string | null | undefined> => {
    try {
      if (!stateBelongsToViewer(scope, profileGeneration)) return undefined
      if (file.size > maxSize) {
        showToast(
          t('imageSizeExceed').replace('{size}', String(Math.round(maxSize / 1024 / 1024))),
          'error'
        )
        return null
      }
      const fileExt = file.name.split('.').pop()?.toLowerCase()
      if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt || '')) {
        showToast(t('onlySupportFormats'), 'error')
        return null
      }

      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', scope.userId)
      formData.append('bucket', bucket)

      const response = await fetch('/api/upload-profile-image', {
        method: 'POST',
        body: formData,
        headers: {
          Authorization: `Bearer ${scope.accessToken}`,
          ...getCsrfHeaders(),
        },
      })
      if (!stateBelongsToViewer(scope, profileGeneration)) return undefined
      const result = await response.json()
      if (!stateBelongsToViewer(scope, profileGeneration)) return undefined
      if (!response.ok) {
        uiLogger.error(`${bucket} upload error:`, result.error)
        showToast(result.error || t('uploadFailed'), 'error')
        return null
      }
      return result.url
    } catch (error: unknown) {
      if (!stateBelongsToViewer(scope, profileGeneration)) return undefined
      const errorMessage = error instanceof Error ? error.message : t('unknownError')
      showToast(`${t('uploadException')}: ${errorMessage}`, 'error')
      return null
    }
  }

  // ===== Save profile =====
  const handleSaveProfile = async () => {
    const scope = captureViewer()
    if (submittingRef.current || saving || !scope) return
    const profileGeneration = profileLoadGenerationRef.current
    if (!stateBelongsToViewer(scope, profileGeneration) || !initialValuesRef.current) {
      showToast(t('saveFailedRetry'), 'error')
      return
    }
    if (handle && !handleValidation.valid) {
      showToast(handleValidation.message, 'error')
      return
    }
    if (handle && handleAvailable === false) {
      showToast(t('usernameInUse'), 'error')
      return
    }

    // Server-side bio length validation
    if (bio && bio.length > 200) {
      showToast(t('bioTooLong'), 'error')
      return
    }

    submittingRef.current = true
    setSaving(true)
    // Capture previous URLs for rollback on any failure path
    const previousAvatarUrl = avatarUrl
    const previousCoverUrl = coverUrl
    try {
      const { data: currentProfile, error: currentProfileError } = await supabase
        .from('user_profiles')
        .select('avatar_url, cover_url')
        .eq('id', scope.userId)
        .maybeSingle()
      if (!stateBelongsToViewer(scope, profileGeneration)) return
      if (currentProfileError || !currentProfile) {
        throw currentProfileError || new Error('Profile provisioning is incomplete')
      }

      let finalAvatarUrl = avatarUrl
      let finalCoverUrl = coverUrl
      let uploadFailed = false

      if (avatarFile) {
        const uploadedUrl = await uploadFile(
          avatarFile,
          'avatars',
          scope,
          profileGeneration,
          5 * 1024 * 1024
        )
        if (!stateBelongsToViewer(scope, profileGeneration) || uploadedUrl === undefined) return
        if (uploadedUrl) {
          finalAvatarUrl = uploadedUrl
          setAvatarUrl(uploadedUrl)
          setPreviewUrl(uploadedUrl)
        } else {
          uploadFailed = true
          setAvatarFile(null)
          if (currentProfile?.avatar_url) {
            finalAvatarUrl = currentProfile.avatar_url
            setPreviewUrl(currentProfile.avatar_url)
          } else setPreviewUrl(null)
        }
      }

      if (coverFile) {
        const uploadedUrl = await uploadFile(
          coverFile,
          'covers',
          scope,
          profileGeneration,
          10 * 1024 * 1024
        )
        if (!stateBelongsToViewer(scope, profileGeneration) || uploadedUrl === undefined) return
        if (uploadedUrl) {
          finalCoverUrl = uploadedUrl
          setCoverUrl(uploadedUrl)
          setCoverPreviewUrl(uploadedUrl)
        } else {
          uploadFailed = true
          setCoverFile(null)
          if (currentProfile?.cover_url) {
            finalCoverUrl = currentProfile.cover_url
            setCoverPreviewUrl(currentProfile.cover_url)
          } else setCoverPreviewUrl(null)
        }
      }

      const profileUpdates: Record<string, unknown> = {
        bio: bio || null,
        avatar_url: finalAvatarUrl || null,
        cover_url: finalCoverUrl || null,
        show_followers: showFollowers,
        show_following: showFollowing,
        dm_permission: dmPermission,
        show_pro_badge: showProBadge,
      }
      if (handle !== initialValuesRef.current?.handle) profileUpdates.handle = handle || null

      const { data: savedProfile, error: saveError } = await supabase
        .from('user_profiles')
        .update(profileUpdates)
        .eq('id', scope.userId)
        .select('id')
        .maybeSingle()
      if (!stateBelongsToViewer(scope, profileGeneration)) return

      if (saveError || !savedProfile) {
        uiLogger.error('Error saving profile:', JSON.stringify(saveError, null, 2))
        // Revert avatar/cover preview on DB save failure
        setPreviewUrl(previousAvatarUrl)
        setAvatarFile(null)
        setCoverPreviewUrl(previousCoverUrl)
        setCoverFile(null)
        if (
          saveError?.code === '23505' ||
          saveError?.message?.includes('unique') ||
          saveError?.message?.includes('duplicate')
        ) {
          showToast(t('usernameInUse'), 'error')
        } else {
          showToast(
            t('saveFailedWithMsg').replace(
              '{msg}',
              saveError?.message || 'Profile update did not match the signed-in user'
            ),
            'error'
          )
        }
        return
      }

      const persistedNotificationValues = initialValuesRef.current
      initialValuesRef.current = {
        handle,
        bio,
        avatarUrl: finalAvatarUrl,
        coverUrl: finalCoverUrl,
        notifyFollow: persistedNotificationValues?.notifyFollow ?? notifyFollow,
        notifyLike: persistedNotificationValues?.notifyLike ?? notifyLike,
        notifyComment: persistedNotificationValues?.notifyComment ?? notifyComment,
        notifyMention: persistedNotificationValues?.notifyMention ?? notifyMention,
        notifyMessage: persistedNotificationValues?.notifyMessage ?? notifyMessage,
        notifyTraderEvents: persistedNotificationValues?.notifyTraderEvents ?? notifyTraderEvents,
        showFollowers,
        showFollowing,
        dmPermission,
        showProBadge,
      }
      setAvatarFile(null)
      setCoverFile(null)

      try {
        await fetch('/api/revalidate/profile', {
          method: 'POST',
          headers: { Authorization: `Bearer ${scope.accessToken}`, ...getCsrfHeaders() },
        })
        if (!stateBelongsToViewer(scope, profileGeneration)) return
      } catch (revalidateError) {
        if (!stateBelongsToViewer(scope, profileGeneration)) return
        logger.warn('[Settings] Failed to revalidate profile cache:', revalidateError)
      }

      if (!stateBelongsToViewer(scope, profileGeneration)) return
      showToast(
        uploadFailed ? t('settingsPartialSaved') : t('settingsSaved'),
        uploadFailed ? 'warning' : 'success'
      )
      router.refresh()
    } catch (error) {
      if (!stateBelongsToViewer(scope, profileGeneration)) return
      uiLogger.error('Error saving:', error)
      // Revert avatar/cover preview on unexpected failure
      setPreviewUrl(previousAvatarUrl)
      setAvatarFile(null)
      setCoverPreviewUrl(previousCoverUrl)
      setCoverFile(null)
      showToast(t('saveFailedRetry'), 'error')
    } finally {
      if (viewerIsCurrent(scope)) {
        setSaving(false)
        submittingRef.current = false
      }
    }
  }

  // ===== Auth handlers =====
  const getFreshToken = async (scope: SettingsViewerSnapshot): Promise<string | null> => {
    if (!viewerIsCurrent(scope)) return null
    const token = await tokenRefreshCoordinator.forceRefresh({
      expectedUserId: scope.userId,
      sessionGeneration: scope.sessionGeneration,
    })
    return viewerIsCurrent(scope) ? token : null
  }

  const handleSendResetCode = async () => {
    const scope = captureViewer()
    if (
      submittingRef.current ||
      sendingResetCode ||
      !scope ||
      !stateBelongsToViewer(scope) ||
      !scope.email
    )
      return
    submittingRef.current = true
    setSendingResetCode(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(scope.email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (!viewerIsCurrent(scope)) return
      if (error) {
        showToast(error.message, 'error')
        return
      }
      setResetCodeSent(true)
      setResetCountdown(60)
      showToast(t('resetEmailSent'), 'success')
    } catch (error: unknown) {
      if (!viewerIsCurrent(scope)) return
      showToast(error instanceof Error ? error.message : t('sendFailed'), 'error')
    } finally {
      if (viewerIsCurrent(scope)) {
        setSendingResetCode(false)
        submittingRef.current = false
      }
    }
  }

  const handleChangePassword = async () => {
    const scope = captureViewer()
    if (
      submittingRef.current ||
      savingPassword ||
      !scope ||
      !stateBelongsToViewer(scope) ||
      !scope.email ||
      !currentPassword ||
      !newPassword
    )
      return
    if (newPassword !== confirmNewPassword) {
      showToast(t('validationPasswordMismatch'), 'error')
      return
    }
    if (newPassword.length < 6) {
      showToast(t('validationPasswordMinLength'), 'error')
      return
    }
    submittingRef.current = true
    setSavingPassword(true)
    try {
      const authScope = {
        expectedUserId: scope.userId,
        sessionGeneration: scope.sessionGeneration,
      }
      const { error: signInError } = await tokenRefreshCoordinator.reauthenticateWithPassword(
        {
          email: scope.email,
          password: currentPassword,
        },
        authScope
      )
      if (!viewerIsCurrent(scope)) return
      if (signInError) {
        showToast(t('currentPasswordWrong'), 'error')
        return
      }
      const { error } = await tokenRefreshCoordinator.updateUser(
        { password: newPassword },
        authScope
      )
      if (!viewerIsCurrent(scope)) return
      if (error) {
        showToast(error.message, 'error')
        return
      }
      // After a password change, terminate OTHER devices FOR REAL. Pass the
      // exact A token explicitly so a late A completion can never read B's
      // newly-active browser session and revoke B's other devices.
      try {
        const revocationToken = await getFreshToken(scope)
        if (!viewerIsCurrent(scope)) return
        if (!revocationToken) throw new Error('Could not refresh the session revocation token')
        const { error: revokeError } = await supabase.auth.admin.signOut(revocationToken, 'others')
        if (!viewerIsCurrent(scope)) return
        if (revokeError) throw revokeError
      } catch (revokeErr) {
        if (!viewerIsCurrent(scope)) return
        // Non-critical: password was changed even if session revocation fails
        uiLogger.warn('[ChangePassword] Failed to revoke other sessions:', revokeErr)
      }
      showToast(t('passwordChanged'), 'success')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
      setTouchedFields((prev) => ({ ...prev, newPassword: false, confirmPassword: false }))
    } catch (error: unknown) {
      if (!viewerIsCurrent(scope)) return
      showToast(error instanceof Error ? error.message : t('changeFailed'), 'error')
    } finally {
      if (viewerIsCurrent(scope)) {
        setSavingPassword(false)
        submittingRef.current = false
      }
    }
  }

  const handleChangeEmail = async () => {
    const scope = captureViewer()
    if (submittingRef.current || savingEmail || !scope || !stateBelongsToViewer(scope) || !newEmail)
      return
    // Basic server-side email format validation before calling Supabase Auth
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(newEmail.trim())) {
      showToast(t('invalidEmailFormat'), 'error')
      return
    }
    submittingRef.current = true
    setSavingEmail(true)
    try {
      const { error } = await tokenRefreshCoordinator.updateUser(
        { email: newEmail.trim() },
        { expectedUserId: scope.userId, sessionGeneration: scope.sessionGeneration }
      )
      if (!viewerIsCurrent(scope)) return
      if (error) {
        showToast(error.message, 'error')
        return
      }
      showToast(t('verificationEmailSent'), 'success')
      setNewEmail('')
      setTouchedFields((prev) => ({ ...prev, newEmail: false }))
    } catch (error: unknown) {
      if (!viewerIsCurrent(scope)) return
      showToast(error instanceof Error ? error.message : t('changeFailed'), 'error')
    } finally {
      if (viewerIsCurrent(scope)) {
        setSavingEmail(false)
        submittingRef.current = false
      }
    }
  }

  // ===== 2FA handlers =====
  const handleSetup2FA = async () => {
    const scope = captureViewer()
    if (submittingRef.current || twoFALoading || !scope || !stateBelongsToViewer(scope)) return
    submittingRef.current = true
    setTwoFALoading(true)
    try {
      const token = await getFreshToken(scope)
      if (!viewerIsCurrent(scope)) return
      if (!token) {
        showToast(t('pleaseLoginFirst'), 'error')
        return
      }
      const res = await fetch('/api/settings/2fa/setup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...getCsrfHeaders() },
      })
      if (!viewerIsCurrent(scope)) return
      const data = await res.json()
      if (!viewerIsCurrent(scope)) return
      if (!res.ok) {
        showToast(data.error || t('operationFailed'), 'error')
        return
      }
      setTwoFASetupData({ qrCodeDataUrl: data.qrCode, secret: data.secret })
    } catch {
      if (!viewerIsCurrent(scope)) return
      showToast(t('networkError'), 'error')
    } finally {
      if (viewerIsCurrent(scope)) {
        setTwoFALoading(false)
        submittingRef.current = false
      }
    }
  }

  const handleVerify2FA = async () => {
    const scope = captureViewer()
    if (
      submittingRef.current ||
      twoFALoading ||
      !scope ||
      !stateBelongsToViewer(scope) ||
      !twoFACode ||
      twoFACode.length !== 6
    )
      return
    submittingRef.current = true
    setTwoFALoading(true)
    try {
      const token = await getFreshToken(scope)
      if (!viewerIsCurrent(scope)) return
      if (!token) {
        showToast(t('pleaseLoginFirst'), 'error')
        return
      }
      const res = await fetch('/api/settings/2fa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ code: twoFACode }),
      })
      if (!viewerIsCurrent(scope)) return
      const data = await res.json()
      if (!viewerIsCurrent(scope)) return
      if (!res.ok) {
        showToast(data.error || t('verificationFailed'), 'error')
        return
      }
      setTwoFAEnabled(true)
      setBackupCodes(data.backupCodes || [])
      setTwoFASetupData(null)
      setTwoFACode('')
      showToast(t('twoFAEnabled'), 'success')
    } catch {
      if (!viewerIsCurrent(scope)) return
      showToast(t('networkError'), 'error')
    } finally {
      if (viewerIsCurrent(scope)) {
        setTwoFALoading(false)
        submittingRef.current = false
      }
    }
  }

  const handleDisable2FA = async () => {
    const scope = captureViewer()
    if (
      submittingRef.current ||
      twoFALoading ||
      !scope ||
      !stateBelongsToViewer(scope) ||
      !disablePassword
    )
      return
    submittingRef.current = true
    setTwoFALoading(true)
    try {
      const token = await getFreshToken(scope)
      if (!viewerIsCurrent(scope)) return
      if (!token) {
        showToast(t('pleaseLoginFirst'), 'error')
        return
      }
      const res = await fetch('/api/settings/2fa/disable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ password: disablePassword }),
      })
      if (!viewerIsCurrent(scope)) return
      const data = await res.json()
      if (!viewerIsCurrent(scope)) return
      if (!res.ok) {
        showToast(data.error || t('closeFailed'), 'error')
        return
      }
      setTwoFAEnabled(false)
      setShowDisable2FA(false)
      setDisablePassword('')
      setBackupCodes([])
      showToast(t('twoFADisabled'), 'success')
    } catch {
      if (!viewerIsCurrent(scope)) return
      showToast(t('networkError'), 'error')
    } finally {
      if (viewerIsCurrent(scope)) {
        setTwoFALoading(false)
        submittingRef.current = false
      }
    }
  }

  // ===== Passkey (WebAuthn) handlers =====
  const loadPasskeys = useCallback(
    async (expectedScope?: SettingsViewerSnapshot) => {
      const scope = expectedScope ?? captureViewer()
      if (!scope) return
      const loadGeneration = ++passkeyLoadGenerationRef.current
      const loadIsCurrent = () =>
        passkeyLoadGenerationRef.current === loadGeneration && viewerIsCurrent(scope)
      setLoadingPasskeys(true)
      try {
        const result = await authedFetch<{ passkeys?: PasskeyInfo[] }>(
          '/api/auth/webauthn/credentials',
          'GET',
          scope.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: scope.userId,
            expectedSessionGeneration: scope.sessionGeneration,
          }
        )
        if (!loadIsCurrent() || result.stale) return
        if (result.ok) {
          setPasskeys(result.data?.passkeys || [])
        }
      } catch (error) {
        if (!loadIsCurrent()) return
        uiLogger.error('[Passkeys] Load error:', error)
      } finally {
        if (loadIsCurrent()) setLoadingPasskeys(false)
      }
    },
    [captureViewer, viewerIsCurrent]
  )

  const handleAddPasskey = async () => {
    const scope = captureViewer()
    if (submittingRef.current || passkeyBusy || !scope || !stateBelongsToViewer(scope)) return
    submittingRef.current = true
    setPasskeyBusy(true)
    try {
      const { startRegistration, browserSupportsWebAuthn } = await import('@simplewebauthn/browser')
      if (!viewerIsCurrent(scope)) return
      if (!browserSupportsWebAuthn()) {
        showToast(t('passkeyNotSupported'), 'error')
        return
      }
      const token = await getFreshToken(scope)
      if (!viewerIsCurrent(scope)) return
      if (!token) {
        showToast(t('pleaseLoginFirst'), 'error')
        return
      }

      const optRes = await fetch('/api/auth/webauthn/registration-options', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...getCsrfHeaders() },
      })
      if (!viewerIsCurrent(scope)) return
      const optData = await optRes.json().catch(() => ({}))
      if (!viewerIsCurrent(scope)) return
      if (!optRes.ok || !optData?.optionsJSON) {
        showToast(optData?.error || t('passkeyError'), 'error')
        return
      }

      let assertion
      try {
        assertion = await startRegistration({ optionsJSON: optData.optionsJSON })
        if (!viewerIsCurrent(scope)) return
      } catch (err) {
        if (!viewerIsCurrent(scope)) return
        const name = (err as Error)?.name
        showToast(
          name === 'NotAllowedError' || name === 'AbortError'
            ? t('passkeyCancelled')
            : t('passkeyError'),
          'error'
        )
        return
      }

      const verifyRes = await fetch('/api/auth/webauthn/registration-verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ assertion, deviceName: newPasskeyName.trim() || undefined }),
      })
      if (!viewerIsCurrent(scope)) return
      const verifyData = await verifyRes.json().catch(() => ({}))
      if (!viewerIsCurrent(scope)) return
      if (!verifyRes.ok || !verifyData?.verified) {
        showToast(verifyData?.error || t('passkeyError'), 'error')
        return
      }

      showToast(t('passkeyAdded'), 'success')
      setNewPasskeyName('')
      await loadPasskeys(scope)
    } catch (error) {
      if (!viewerIsCurrent(scope)) return
      uiLogger.error('[Passkeys] Add error:', error)
      showToast(t('passkeyError'), 'error')
    } finally {
      if (viewerIsCurrent(scope)) {
        setPasskeyBusy(false)
        submittingRef.current = false
      }
    }
  }

  const handleRemovePasskey = async (id: string) => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    const confirmed = await showConfirm(t('passkeyRemoveTitle'), t('passkeyRemoveConfirm'))
    if (!confirmed || !viewerIsCurrent(scope)) return
    try {
      const token = await getFreshToken(scope)
      if (!viewerIsCurrent(scope)) return
      if (!token) {
        showToast(t('pleaseLoginFirst'), 'error')
        return
      }
      const res = await fetch('/api/auth/webauthn/credentials', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ id }),
      })
      if (!viewerIsCurrent(scope)) return
      if (res.ok) {
        setPasskeys((prev) => prev.filter((p) => p.id !== id))
        showToast(t('passkeyRemoved'), 'success')
      } else {
        showToast(t('operationFailed'), 'error')
      }
    } catch {
      if (!viewerIsCurrent(scope)) return
      showToast(t('networkError'), 'error')
    }
  }

  // ===== Sessions handlers =====
  const loadSessions = useCallback(async () => {
    const scope = captureViewer()
    if (!scope) return
    const loadGeneration = ++sessionLoadGenerationRef.current
    const loadIsCurrent = () =>
      sessionLoadGenerationRef.current === loadGeneration && viewerIsCurrent(scope)
    setLoadingSessions(true)
    try {
      const result = await authedFetch<{
        sessions?: Array<{
          id: string
          deviceInfo: string | null
          ipAddress: string | null
          lastActiveAt: string | null
        }>
      }>('/api/settings/sessions', 'GET', scope.accessToken, undefined, 15_000, {
        expectedUserId: scope.userId,
        expectedSessionGeneration: scope.sessionGeneration,
      })
      if (!loadIsCurrent() || result.stale) return
      if (result.ok) {
        const sessionList = result.data?.sessions || []
        setSessions(
          sessionList.map((s, index) => ({
            id: s.id,
            deviceInfo: s.deviceInfo
              ? ((typeof s.deviceInfo === 'string' ? JSON.parse(s.deviceInfo) : s.deviceInfo) as {
                  browser?: string
                  os?: string
                })
              : null,
            ipAddress: s.ipAddress,
            lastActiveAt: s.lastActiveAt,
            isCurrent: index === 0,
          }))
        )
      }
    } catch (error) {
      if (!loadIsCurrent()) return
      uiLogger.error('[Sessions] Load error:', error)
    } finally {
      if (loadIsCurrent()) setLoadingSessions(false)
    }
  }, [captureViewer, viewerIsCurrent])

  const handleRevokeSession = async (sessionId: string) => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    try {
      const result = await authedFetch(
        '/api/settings/sessions',
        'DELETE',
        scope.accessToken,
        {
          sessionId,
        },
        15_000,
        {
          expectedUserId: scope.userId,
          expectedSessionGeneration: scope.sessionGeneration,
        }
      )
      if (!viewerIsCurrent(scope) || result.stale) return
      if (result.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId))
        showToast(t('sessionRevoked'), 'success')
      } else showToast(t('operationFailed'), 'error')
    } catch {
      if (!viewerIsCurrent(scope)) return
      showToast(t('networkError'), 'error')
    }
  }

  const handleRevokeAllSessions = async () => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    const confirmed = await showConfirm(t('logoutAllDevices'), t('logoutAllDevicesConfirm'))
    if (!confirmed || !viewerIsCurrent(scope)) return
    try {
      const result = await authedFetch(
        '/api/settings/sessions',
        'DELETE',
        scope.accessToken,
        {
          all: true,
        },
        15_000,
        {
          expectedUserId: scope.userId,
          expectedSessionGeneration: scope.sessionGeneration,
        }
      )
      if (!viewerIsCurrent(scope) || result.stale) return
      if (result.ok) {
        setSessions((prev) => prev.filter((s) => s.isCurrent))
        showToast(t('logoutAllSuccess'), 'success')
      } else showToast(t('operationFailed'), 'error')
    } catch {
      if (!viewerIsCurrent(scope)) return
      showToast(t('networkError'), 'error')
    }
  }

  // ===== Blocked users handlers =====
  const loadBlockedUsers = useCallback(async () => {
    const scope = captureViewer()
    if (!scope) return
    const loadGeneration = ++blockedUsersLoadGenerationRef.current
    const loadIsCurrent = () =>
      blockedUsersLoadGenerationRef.current === loadGeneration && viewerIsCurrent(scope)
    setLoadingBlockedUsers(true)
    try {
      const { data: blockedRows, error } = await supabase
        .from('blocked_users')
        .select('blocked_id, created_at')
        .eq('blocker_id', scope.userId)
      if (!loadIsCurrent()) return
      if (error || !blockedRows) throw error || new Error('Blocked users read returned no rows')
      if (blockedRows.length === 0) {
        setBlockedUsers([])
        return
      }
      const blockedIds = blockedRows.map((r) => r.blocked_id as string)
      const { data: profiles, error: profilesError } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url')
        .in('id', blockedIds)
      if (!loadIsCurrent()) return
      if (profilesError || !profiles) {
        throw profilesError || new Error('Blocked profile read returned no rows')
      }
      const profileMap = new Map((profiles || []).map((p) => [p.id as string, p]))
      setBlockedUsers(
        blockedRows.map((row) => {
          const profile = profileMap.get(row.blocked_id as string)
          return {
            blockedId: row.blocked_id as string,
            handle: (profile?.handle as string) || null,
            avatarUrl: (profile?.avatar_url as string) || null,
            createdAt: row.created_at as string,
          }
        })
      )
    } catch (error) {
      if (!loadIsCurrent()) return
      uiLogger.error('[BlockedUsers] Load error:', error)
    } finally {
      if (loadIsCurrent()) setLoadingBlockedUsers(false)
    }
  }, [captureViewer, viewerIsCurrent])

  const handleUnblock = async (blockedId: string) => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    setUnblockingId(blockedId)
    try {
      const result = await authedFetch(
        `/api/users/${blockedId}/block`,
        'DELETE',
        scope.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: scope.userId,
          expectedSessionGeneration: scope.sessionGeneration,
        }
      )
      if (!viewerIsCurrent(scope) || result.stale) return
      if (result.ok) {
        setBlockedUsers((prev) => prev.filter((u) => u.blockedId !== blockedId))
        showToast(t('unblocked'), 'success')
      } else showToast(t('operationFailed'), 'error')
    } catch {
      if (!viewerIsCurrent(scope)) return
      showToast(t('networkError'), 'error')
    } finally {
      if (viewerIsCurrent(scope)) setUnblockingId(null)
    }
  }

  // ===== Email digest handler =====
  const handleEmailDigestChange = (value: EmailDigestValue) => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) {
      setEmailDigest(emailDigestPersistedRef.current)
      showToast(t('saveFailed'), 'error')
      return
    }

    const previousPersisted = emailDigestPersistedRef.current
    setEmailDigest(value)
    void emailDigestQueueRef.current?.enqueue(
      'email_digest',
      value,
      previousPersisted,
      setEmailDigest,
      {
        accessToken: scope.accessToken,
        userId: scope.userId,
        sessionGeneration: scope.sessionGeneration,
      }
    )
  }

  // ===== Account handlers =====
  const handleLogout = async () => {
    const scope = captureViewer()
    if (!scope) return
    const confirmed = await showConfirm(t('logoutTitle'), t('logoutConfirm'))
    if (!confirmed || !viewerIsCurrent(scope)) return
    try {
      const { clearProStatusCache } = await import('@/lib/hooks/useProStatus')
      if (!viewerIsCurrent(scope)) return
      clearProStatusCache()
      try {
        sessionStorage.clear()
      } catch {
        /* ignore */
      }
      try {
        localStorage.removeItem('guest-signup-dismissed')
      } catch {
        /* ignore */
      }
      await auth.signOut()
      router.push('/')
    } catch {
      if (viewerIsCurrent(scope)) showToast(t('logoutFailed'), 'error')
    }
  }

  // 打开删号弹窗时探测账号是否有密码凭据(OAuth/钱包用户无 → 走 DELETE 确认)。
  useEffect(() => {
    if (!showDeleteAccountModal) return
    const scope = captureViewer()
    if (!scope || auth.user?.id !== scope.userId) return
    const providers = (auth.user.identities ?? []).map((identity) => identity.provider)
    const isWalletEmail = (auth.user.email ?? '').endsWith('@wallet.arena')
    setDeleteHasPassword(!isWalletEmail && providers.includes('email'))
  }, [auth.sessionGeneration, auth.user, captureViewer, showDeleteAccountModal])

  const handleDeleteAccount = async () => {
    // 有密码用户需填密码;无密码(OAuth/钱包)需键入 DELETE。
    if (deleteHasPassword ? !deletePassword : deleteConfirm.trim().toUpperCase() !== 'DELETE')
      return
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    setDeletingAccount(true)
    setDeleteError(null)
    try {
      const token = await getFreshToken(scope)
      if (!viewerIsCurrent(scope)) return
      if (!token) {
        setDeleteError(t('pleaseLoginAgain'))
        return
      }
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify(
          deleteHasPassword
            ? { password: deletePassword, reason: deleteReason }
            : { confirm: deleteConfirm, reason: deleteReason }
        ),
      })
      if (!viewerIsCurrent(scope)) return
      const data = await res.json()
      if (!viewerIsCurrent(scope)) return
      if (!res.ok) {
        setDeleteError(data.error || t('operationFailed'))
        return
      }
      if (typeof data.recovery_token === 'string' && data.recovery_token) {
        // One-time credential for OAuth/wallet recovery. The server stores only
        // its SHA-256 hash; retain the plaintext only on this device.
        localStorage.setItem('arena_account_recovery_token', data.recovery_token)
      }
      showToast(t('accountMarkedDeleted'), 'success')
      setShowDeleteAccountModal(false)
      setDeletingAccount(false)
      await auth.signOut()
      router.push('/login?recover=1')
    } catch {
      if (viewerIsCurrent(scope)) setDeleteError(t('networkErrorRetry'))
    } finally {
      if (viewerIsCurrent(scope)) setDeletingAccount(false)
    }
  }

  // ===== Notification toggle auto-save =====
  const handleNotificationToggleSave = useCallback(
    (
      field: NotificationPreferenceField,
      value: boolean,
      previousValue: boolean,
      setter: (nextValue: boolean) => void
    ) => {
      const scope = captureViewer()
      if (!scope || !stateBelongsToViewer(scope)) {
        setter(previousValue)
        showToast(t('saveFailed'), 'error')
        return
      }

      void notificationQueueRef.current?.enqueue(field, value, previousValue, setter, {
        accessToken: scope.accessToken,
        userId: scope.userId,
        sessionGeneration: scope.sessionGeneration,
      })
    },
    [captureViewer, showToast, stateBelongsToViewer, t]
  )

  const canonicalViewer = captureSettingsViewer(auth)
  const profileLoadOutcome = profileLoadOutcomeRef.current
  const viewerBoundaryPending =
    !!auth.userId &&
    (!canonicalViewer ||
      !profileLoadOutcome ||
      !settingsScopeMatches(profileLoadOutcome, canonicalViewer))

  return {
    // Auth state
    email,
    userId,
    loading: loading || auth.loading || !auth.authChecked || viewerBoundaryPending,
    saving,

    // Profile state
    handle,
    setHandle,
    bio,
    setBio,
    previewUrl,
    coverPreviewUrl,
    coverUrl,
    handleAvailable,
    checkingHandle,
    initialValuesRef,

    // Image cropper
    showAvatarCropper,
    showCoverCropper,
    cropImageSrc,
    setShowAvatarCropper,
    setShowCoverCropper,
    setCropImageSrc,

    // Validation
    touchedFields,
    markTouched,
    handleValidation,

    // Password
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmNewPassword,
    setConfirmNewPassword,
    savingPassword,
    passwordResetMode,
    setPasswordResetMode,
    resetCodeSent,
    sendingResetCode,
    resetCountdown,
    savingEmail,
    newEmail,
    setNewEmail,

    // 2FA
    twoFAEnabled,
    twoFASetupData,
    twoFACode,
    setTwoFACode,
    backupCodes,
    twoFALoading,
    showDisable2FA,
    setShowDisable2FA,
    disablePassword,
    setDisablePassword,

    // Passkeys
    passkeys,
    loadingPasskeys,
    passkeyBusy,
    newPasskeyName,
    setNewPasskeyName,
    loadPasskeys,
    handleAddPasskey,
    handleRemovePasskey,

    // Sessions
    sessions,
    loadingSessions,

    // Notifications
    notifyFollow,
    setNotifyFollow,
    notifyLike,
    setNotifyLike,
    notifyComment,
    setNotifyComment,
    notifyMention,
    setNotifyMention,
    notifyMessage,
    setNotifyMessage,
    notifyTraderEvents,
    setNotifyTraderEvents,
    hapticEnabled,
    setHapticEnabled,
    emailDigest,

    // Privacy
    showFollowers,
    setShowFollowers,
    showFollowing,
    setShowFollowing,
    dmPermission,
    setDmPermission,
    showProBadge,
    setShowProBadge,

    // Blocked users
    blockedUsers,
    loadingBlockedUsers,
    unblockingId,

    // Delete account
    showDeleteAccountModal,
    setShowDeleteAccountModal,
    deletePassword,
    setDeletePassword,
    deleteReason,
    setDeleteReason,
    deleteConfirm,
    setDeleteConfirm,
    deleteHasPassword,
    deletingAccount,
    deleteError,

    // Handlers
    loadProfile,
    hasUnsavedChanges,
    handleAvatarChange,
    handleAvatarCropComplete,
    handleCoverChange,
    handleCoverCropComplete,
    handleRemoveCover,
    handleSaveProfile,
    handleSendResetCode,
    handleChangePassword,
    handleChangeEmail,
    handleSetup2FA,
    handleVerify2FA,
    handleDisable2FA,
    loadSessions,
    handleRevokeSession,
    handleRevokeAllSessions,
    loadBlockedUsers,
    handleUnblock,
    handleEmailDigestChange,
    handleLogout,
    handleDeleteAccount,
    handleNotificationToggleSave,

    // For resetting
    setAvatarFile,
    setCoverFile,
    setHandleAvailable,
    setTouchedFields,
  }
}
