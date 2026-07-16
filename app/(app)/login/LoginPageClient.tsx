'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase as _supabase } from '@/lib/supabase/client'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import { useRouter, useSearchParams } from 'next/navigation'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { logger } from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { useMultiAccountStore } from '@/lib/stores/multiAccountStore'
import {
  injectStyles,
  validateEmail,
  getPasswordStrength,
  validateHandle,
} from './components/loginHelpers'
import { trackEvent } from '@/lib/analytics/track'
import { peekPendingReferral } from '@/lib/referral/pending'
import SocialLogin from './components/SocialLogin'
import RegisterForm from './components/RegisterForm'
import LoginForm from './components/LoginForm'
import { formatRankedTraderCount } from '@/lib/config/product-facts'
import { useProductFacts } from '@/lib/hooks/useProductFacts'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { normalizeHandle } from '@/lib/identity/handle-policy'
import {
  assertExactLoginIdentityCurrent,
  exactSessionJsonRequest,
  verifyExactLoginIdentity,
  type ExactLoginIdentity,
} from '@/lib/auth/login-identity'
import { safeInternalReturnPath } from '@/lib/auth/safe-return-path'
import { StaleVerifiedSessionError } from '@/lib/auth/verified-session'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import {
  getCurrentAuthOperation,
  getStoredAuthSession,
  isAuthOperationCurrent,
  type AuthOperationLease,
} from '@/lib/auth/session-operation'

type LoginAuthBoundary = Readonly<{
  authOperation: AuthOperationLease | null
  viewerScope: ReturnType<typeof getViewerScope>
  accessToken: string | null
}>

type LoginAttempt = Readonly<{
  generation: number
  controller: AbortController
  authBoundary: LoginAuthBoundary
}>

type LoginProfile = {
  id: string
  handle: string | null
  avatar_url: string | null
}

class StaleLoginAttemptError extends Error {
  constructor() {
    super('Login operation was superseded')
    this.name = 'StaleLoginAttemptError'
  }
}

class MissingProvisionedProfileError extends Error {
  constructor() {
    super('Profile provisioning is incomplete')
    this.name = 'MissingProvisionedProfileError'
  }
}

function isCancellation(error: unknown): boolean {
  return (
    error instanceof StaleLoginAttemptError ||
    error instanceof StaleVerifiedSessionError ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
}

function isSupersededAuthError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'auth_operation_superseded'
  )
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeLocalStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Storage cleanup is best-effort; identity CAS remains authoritative.
  }
}

function safeSessionStorageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSessionStorageSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // Countdown persistence is optional; the OTP flow remains usable.
  }
}

function safeSessionStorageRemove(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Private-mode storage failures must not block the form reset.
  }
}

function captureLoginAuthBoundary(): LoginAuthBoundary {
  const storedSession = getStoredAuthSession()
  return {
    authOperation: getCurrentAuthOperation(),
    viewerScope: getViewerScope(),
    accessToken:
      typeof storedSession?.access_token === 'string' ? storedSession.access_token : null,
  }
}

function isLoginAuthBoundaryCurrent(boundary: LoginAuthBoundary): boolean {
  const operationCurrent = boundary.authOperation
    ? isAuthOperationCurrent(boundary.authOperation)
    : getCurrentAuthOperation() === null
  const storedSession = getStoredAuthSession()
  const accessToken =
    typeof storedSession?.access_token === 'string' ? storedSession.access_token : null
  return (
    operationCurrent &&
    isViewerScopeCurrent(boundary.viewerScope) &&
    accessToken === boundary.accessToken
  )
}

export default function LoginPageClient() {
  const { language: lang, t } = useLanguage()
  const { signOut } = useAuthSession()
  const [isRegister, setIsRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [handle, setHandle] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [codeVerified, setCodeVerified] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [countdown, setCountdown] = useState(() => {
    if (typeof window === 'undefined') return 0
    const savedEnd = Number(safeSessionStorageGet('otp_countdown_end') || 0)
    const remaining = Math.max(0, Math.ceil((savedEnd - Date.now()) / 1000))
    return remaining > 0 ? remaining : 0
  })
  const [loginWithCode, setLoginWithCode] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [accountRecoveryToken, setAccountRecoveryToken] = useState<string | null>(null)
  const [rateLimitCountdown, setRateLimitCountdown] = useState(0)

  const [touchedFields, setTouchedFields] = useState<{
    email: boolean
    password: boolean
    handle: boolean
  }>({ email: false, password: false, handle: false })

  const errorRef = useRef<HTMLDivElement>(null)
  const submittingRef = useRef(false)
  const verifyingOtpRef = useRef(false)
  const otpAttemptsRef = useRef(0)
  const mountedRef = useRef(false)
  const attemptGenerationRef = useRef(0)
  const activeAttemptRef = useRef<LoginAttempt | null>(null)
  const registrationIdentityRef = useRef<ExactLoginIdentity | null>(null)
  const isRegisterRef = useRef(isRegister)
  const codeVerifiedRef = useRef(codeVerified)
  const [otpLocked, setOtpLocked] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const productFacts = useProductFacts()

  const isAddAccount = searchParams.get('addAccount') === 'true'
  isRegisterRef.current = isRegister
  codeVerifiedRef.current = codeVerified

  const beginAttempt = useCallback((): LoginAttempt => {
    activeAttemptRef.current?.controller.abort()
    const attempt = {
      generation: ++attemptGenerationRef.current,
      controller: new AbortController(),
      authBoundary: captureLoginAuthBoundary(),
    }
    activeAttemptRef.current = attempt
    return attempt
  }, [])

  const isAttemptCurrent = useCallback(
    (attempt: LoginAttempt): boolean =>
      mountedRef.current &&
      activeAttemptRef.current?.generation === attempt.generation &&
      !attempt.controller.signal.aborted,
    []
  )

  const assertAttemptCurrent = useCallback(
    (attempt: LoginAttempt, identity?: ExactLoginIdentity): void => {
      if (!isAttemptCurrent(attempt)) throw new StaleLoginAttemptError()
      if (identity) assertExactLoginIdentityCurrent(identity)
    },
    [isAttemptCurrent]
  )

  const assertAttemptAuthBoundaryCurrent = useCallback(
    (attempt: LoginAttempt): void => {
      if (!isAttemptCurrent(attempt) || !isLoginAuthBoundaryCurrent(attempt.authBoundary)) {
        throw new StaleLoginAttemptError()
      }
    },
    [isAttemptCurrent]
  )

  const cancelAttempt = useCallback((expected?: LoginAttempt): void => {
    if (expected && activeAttemptRef.current?.generation !== expected.generation) return
    activeAttemptRef.current?.controller.abort()
    activeAttemptRef.current = null
    attemptGenerationRef.current += 1
  }, [])

  const hasAddAccountIntent = useCallback(
    () => isAddAccount || safeLocalStorageGet('arena_adding_account') === 'true',
    [isAddAccount]
  )

  const getRedirectUrl = useCallback(
    (_userHandle?: string | null, _userEmail?: string | null): string => {
      if (hasAddAccountIntent()) {
        return '/'
      }
      const returnUrl = searchParams.get('returnUrl') || searchParams.get('redirect')
      const safeReturnUrl = safeInternalReturnPath(returnUrl)
      if (safeReturnUrl) return safeReturnUrl
      // Default to homepage — the ranking table is the main content on /
      return '/'
    },
    [hasAddAccountIntent, searchParams]
  )

  const emailValidation = validateEmail(email)

  const markTouched = (field: 'email' | 'password' | 'handle') => {
    setTouchedFields((prev) => ({ ...prev, [field]: true }))
  }

  const supersedeInteractiveAttempt = useCallback(() => {
    if (activeAttemptRef.current) cancelAttempt()
    submittingRef.current = false
    verifyingOtpRef.current = false
    setLoading(false)
    setSendingCode(false)
    setRecovering(false)
  }, [cancelAttempt])

  const loadProvisionedProfile = useCallback(
    async (attempt: LoginAttempt, identity: ExactLoginIdentity): Promise<LoginProfile> => {
      assertAttemptCurrent(attempt, identity)
      const { data, error: profileError } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url')
        .eq('id', identity.user.id)
        .abortSignal(attempt.controller.signal)
        .maybeSingle()
      assertAttemptCurrent(attempt, identity)

      if (profileError) {
        throw Object.assign(new Error(profileError.message || 'Failed to load user profile'), {
          code: profileError.code,
        })
      }
      if (!data || data.id !== identity.user.id) throw new MissingProvisionedProfileError()
      return data
    },
    [assertAttemptCurrent]
  )

  const verifyAttemptSession = useCallback(
    async (
      attempt: LoginAttempt,
      session: Session,
      allowPendingViewer = false
    ): Promise<ExactLoginIdentity> => {
      assertAttemptCurrent(attempt)
      const identity = await verifyExactLoginIdentity(supabase, session, {
        allowPendingViewer,
      })
      assertAttemptCurrent(attempt, identity)
      return identity
    },
    [assertAttemptCurrent]
  )

  const commitMultiAccount = useCallback(
    (attempt: LoginAttempt, identity: ExactLoginIdentity, profile: LoginProfile): boolean => {
      if (!hasAddAccountIntent()) return false
      assertAttemptCurrent(attempt, identity)

      const account = {
        userId: identity.user.id,
        email: identity.user.email || '',
        handle: profile.handle,
        avatarUrl: profile.avatar_url,
        refreshToken: identity.session.refresh_token,
        lastActiveAt: new Date().toISOString(),
        isActive: true,
      }
      useMultiAccountStore.setState((state) => {
        let replaced = false
        const accounts = state.accounts.map((existing) => {
          if (existing.userId === account.userId) {
            replaced = true
            return account
          }
          return existing.isActive ? { ...existing, isActive: false } : existing
        })
        return { accounts: replaced ? accounts : [...accounts, account] }
      })

      // A synchronous store subscriber could start another identity operation.
      // Re-check before clearing the cross-page add-account intent.
      assertAttemptCurrent(attempt, identity)
      safeLocalStorageRemove('arena_adding_account')
      return true
    },
    [assertAttemptCurrent, hasAddAccountIntent]
  )

  const loadAuthenticatedSession = useCallback(
    async (attempt: LoginAttempt, session: Session, allowPendingViewer = false) => {
      const identity = await verifyAttemptSession(attempt, session, allowPendingViewer)
      const profile = await loadProvisionedProfile(attempt, identity)
      assertAttemptCurrent(attempt, identity)
      return { identity, profile }
    },
    [assertAttemptCurrent, loadProvisionedProfile, verifyAttemptSession]
  )

  const commitLogin = useCallback(
    (
      attempt: LoginAttempt,
      identity: ExactLoginIdentity,
      profile: LoginProfile,
      options: { replace?: boolean; track?: boolean } = {}
    ) => {
      assertAttemptCurrent(attempt, identity)
      const addedAccount = commitMultiAccount(attempt, identity, profile)
      assertAttemptCurrent(attempt, identity)
      if (options.track) trackEvent('login')
      const destination = addedAccount ? '/' : getRedirectUrl(profile.handle, identity.user.email)
      if (options.replace) router.replace(destination)
      else router.push(destination)
    },
    [assertAttemptCurrent, commitMultiAccount, getRedirectUrl, router]
  )

  const rollbackSession = useCallback(
    async (session: Session, errorMessage?: string): Promise<boolean> => {
      const rolledBack = await tokenRefreshCoordinator.signOutIfCurrent(
        session.user.id,
        session.access_token
      )
      if (!rolledBack || !mountedRef.current) return rolledBack

      const viewer = getViewerScope()
      if (
        errorMessage &&
        viewer.viewerKey === 'anon' &&
        viewer.userId === null &&
        isViewerScopeCurrent(viewer)
      ) {
        setError(errorMessage)
      }
      return true
    },
    []
  )

  const handleExternalSession = useCallback(
    async (session: Session, replace: boolean) => {
      const attempt = beginAttempt()
      let committed = false
      try {
        const { identity, profile } = await loadAuthenticatedSession(attempt, session, true)
        commitLogin(attempt, identity, profile, { replace })
        committed = true
      } catch (sessionError) {
        if (!isCancellation(sessionError)) {
          logger.error('External login completion failed:', sessionError)
        }
        if (!committed) await rollbackSession(session, t('loginSetupFailed'))
      }
    },
    [beginAttempt, commitLogin, loadAuthenticatedSession, rollbackSession, t]
  )

  useEffect(() => {
    mountedRef.current = true
    injectStyles()
    setMounted(true)
    return () => {
      mountedRef.current = false
      registrationIdentityRef.current = null
      submittingRef.current = false
      verifyingOtpRef.current = false
      cancelAttempt()
    }
  }, [cancelAttempt])

  useEffect(() => {
    // Show error from auth callback redirect or OAuth provider errors
    const errorParam = searchParams.get('error')
    if (errorParam === 'auth_failed') {
      setError(t('loginAuthFailed'))
    } else if (errorParam === 'no_session') {
      setError(t('loginNoSession'))
    } else if (errorParam) {
      // Generic error from OAuth callback or other redirects (e.g. provider cancelled)
      setError(decodeURIComponent(errorParam))
    }
    const storedRecoveryToken = safeLocalStorageGet('arena_account_recovery_token')
    if (searchParams.get('recover') === '1' && storedRecoveryToken) {
      setAccountRecoveryToken(storedRecoveryToken)
      setError(t('loginAccountPendingDeletion'))
      setShowRecoveryPrompt(true)
    }
  }, [searchParams, t])

  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.classList.remove('error-shake')
      void errorRef.current.offsetWidth
      errorRef.current.classList.add('error-shake')
    }
  }, [error])

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        registrationIdentityRef.current = null
        if (!submittingRef.current && !verifyingOtpRef.current) cancelAttempt()
        return
      }
      if (
        (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') &&
        session &&
        !isRegisterRef.current &&
        !codeVerifiedRef.current &&
        !verifyingOtpRef.current &&
        !submittingRef.current
      ) {
        if (event !== 'SIGNED_IN' && hasAddAccountIntent()) return
        setRecovering(false)
        void handleExternalSession(session, event !== 'SIGNED_IN')
      }
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [cancelAttempt, handleExternalSession, hasAddAccountIntent])

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  useEffect(() => {
    if (rateLimitCountdown > 0) {
      const timer = setTimeout(() => setRateLimitCountdown(rateLimitCountdown - 1), 1000)
      return () => clearTimeout(timer)
    } else if (rateLimitCountdown === 0) {
      // Clear rate limit error when countdown reaches 0
      setError((prev) =>
        prev &&
        (prev.includes('Too many attempts') ||
          prev.includes('操作过于频繁') ||
          prev.includes('Try again in') ||
          prev.includes('秒后重试'))
          ? null
          : prev
      )
    }
  }, [rateLimitCountdown])

  // Auth handlers
  const handleSendCode = async () => {
    if (submittingRef.current || sendingCode) return
    if (!email) {
      setError(t('loginPleaseEnterEmail'))
      return
    }
    submittingRef.current = true
    const attempt = beginAttempt()
    setError(null)
    setSendingCode(true)

    // 15-second timeout — Supabase OTP delivery can hang on slow networks
    const timeoutId = setTimeout(() => {
      if (!isAttemptCurrent(attempt)) return
      cancelAttempt(attempt)
      setError(t('loginTimeout'))
      setSendingCode(false)
      submittingRef.current = false
    }, 15_000)

    try {
      const { data, error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      })
      assertAttemptAuthBoundaryCurrent(attempt)
      clearTimeout(timeoutId)
      if (otpError) {
        setError(
          otpError.message.includes('redirect') || otpError.message.includes('link')
            ? t('loginConfigError')
            : t('loginSendFailed')
        )
        setSendingCode(false)
        return
      }
      if (data) {
        setCodeSent(true)
        setCountdown(60)
        safeSessionStorageSet('otp_countdown_end', String(Date.now() + 60000))
        otpAttemptsRef.current = 0
        setOtpLocked(false)
        showToast(t('loginCodeSent'), 'success')
      } else {
        setError(t('loginSendFailed'))
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId)
      if (isCancellation(err)) return
      logger.error('Login OTP error:', err)
      if (isAttemptCurrent(attempt)) setError(t('loginSendFailedNetwork'))
    } finally {
      clearTimeout(timeoutId)
      if (isAttemptCurrent(attempt)) {
        setSendingCode(false)
        submittingRef.current = false
      }
    }
  }

  const handleSendLoginCode = async () => {
    if (submittingRef.current || sendingCode) return
    if (!email) {
      setError(t('loginPleaseEnterEmail'))
      return
    }
    submittingRef.current = true
    const attempt = beginAttempt()
    setError(null)
    setSendingCode(true)

    // 15-second timeout — matches handleSendCode pattern
    const timeoutId = setTimeout(() => {
      if (!isAttemptCurrent(attempt)) return
      cancelAttempt(attempt)
      setError(t('loginTimeout'))
      setSendingCode(false)
      submittingRef.current = false
    }, 15_000)

    try {
      const { data, error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      })
      assertAttemptAuthBoundaryCurrent(attempt)
      clearTimeout(timeoutId)
      if (otpError) {
        const msg = otpError.message.toLowerCase()
        // Account-enumeration safety: never reveal whether an email is registered.
        // "signup disabled / not found" is treated the same as success (neutral
        // "code sent"), matching the reset-password flow. Real failures (rate
        // limit, network) still surface so the user can react.
        if (msg.includes('signup') || msg.includes('not allowed') || msg.includes('not found')) {
          setCodeSent(true)
          setCountdown(60)
          safeSessionStorageSet('otp_countdown_end', String(Date.now() + 60000))
          otpAttemptsRef.current = 0
          setOtpLocked(false)
          showToast(t('loginCodeSent'), 'success')
        } else {
          setError(t('loginSendFailedShort'))
        }
        setSendingCode(false)
        return
      }
      if (data) {
        setCodeSent(true)
        setCountdown(60)
        safeSessionStorageSet('otp_countdown_end', String(Date.now() + 60000))
        otpAttemptsRef.current = 0
        setOtpLocked(false)
        showToast(t('loginCodeSent'), 'success')
      } else {
        setError(t('loginSendFailedShort'))
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId)
      if (isCancellation(err)) return
      logger.error('Login OTP error:', err)
      if (isAttemptCurrent(attempt)) setError(t('loginSendFailedSimple'))
    } finally {
      clearTimeout(timeoutId)
      if (isAttemptCurrent(attempt)) {
        setSendingCode(false)
        submittingRef.current = false
      }
    }
  }

  const synchronizeUserProfile = useCallback(
    async (
      attempt: LoginAttempt,
      identity: ExactLoginIdentity,
      userHandle: string
    ): Promise<LoginProfile> => {
      const normalizedUserHandle = normalizeHandle(userHandle)
      if (!validateHandle(normalizedUserHandle).valid) {
        throw new Error('Invalid profile handle')
      }

      // The database trigger is the sole profile provisioner. A missing row is
      // a hard authentication failure; browser code never inserts or upserts it.
      const existingProfile = await loadProvisionedProfile(attempt, identity)
      const updateData: Record<string, string> = {}
      if (existingProfile.handle !== normalizedUserHandle) {
        updateData.handle = normalizedUserHandle
      }

      const meta = identity.user.user_metadata
      const oauthAvatar = meta?.avatar_url || meta?.picture || null
      if (typeof oauthAvatar === 'string' && oauthAvatar && !existingProfile.avatar_url) {
        updateData.avatar_url = oauthAvatar
      }

      if (Object.keys(updateData).length > 0) {
        assertAttemptCurrent(attempt, identity)
        const { data: updatedProfile, error: profileUpdateError } = await supabase
          .from('user_profiles')
          .update(updateData)
          .eq('id', identity.user.id)
          .select('id')
          .abortSignal(attempt.controller.signal)
          .maybeSingle()
        assertAttemptCurrent(attempt, identity)
        if (profileUpdateError) {
          throw Object.assign(
            new Error(profileUpdateError.message || 'Failed to update user profile'),
            { code: profileUpdateError.code }
          )
        }
        if (!updatedProfile || updatedProfile.id !== identity.user.id) {
          throw new Error('Profile update did not match the signed-in user')
        }
        if (updateData.handle) existingProfile.handle = updateData.handle
        if (updateData.avatar_url) existingProfile.avatar_url = updateData.avatar_url
      }

      // Privileged first-touch attribution uses the exact verified bearer. A
      // 401 is not retried with a newer token because that would detach the
      // request from this registration operation.
      const utmSource = searchParams.get('utm_source')
      const utmMedium = searchParams.get('utm_medium')
      const utmCampaign = searchParams.get('utm_campaign')
      if (utmSource || utmMedium || utmCampaign) {
        try {
          const attribution = await exactSessionJsonRequest<{ success?: unknown }>(
            identity,
            '/api/profile/attribution',
            {
              ...(utmSource ? { utmSource } : {}),
              ...(utmMedium ? { utmMedium } : {}),
              ...(utmCampaign ? { utmCampaign } : {}),
            },
            { signal: attempt.controller.signal }
          )
          assertAttemptCurrent(attempt, identity)
          if (!attribution.ok || attribution.data?.success !== true) {
            logger.warn('Profile attribution failed (non-fatal)')
          }
        } catch (attributionError) {
          if (isCancellation(attributionError) || !isAttemptCurrent(attempt)) {
            throw attributionError
          }
          logger.warn('Profile attribution failed (non-fatal):', attributionError)
        }
      }

      // Referral application is also exact-bearer and idempotent server-side.
      assertAttemptCurrent(attempt, identity)
      const refCode = searchParams.get('ref') || peekPendingReferral()
      if (refCode) {
        try {
          await exactSessionJsonRequest(
            identity,
            '/api/referral/apply',
            { code: refCode },
            {
              signal: attempt.controller.signal,
            }
          )
          assertAttemptCurrent(attempt, identity)
        } catch (refErr) {
          if (isCancellation(refErr) || !isAttemptCurrent(attempt)) throw refErr
          logger.error('Referral apply failed (non-fatal):', refErr)
        }
      }

      return existingProfile
    },
    [assertAttemptCurrent, isAttemptCurrent, loadProvisionedProfile, searchParams]
  )

  const handleVerifyCode = async () => {
    if (submittingRef.current || loading) return
    if (otpLocked) {
      setError(t('loginTooManyAttemptsCode'))
      return
    }
    if (!code) {
      setError(t('loginPleaseEnterCode'))
      return
    }
    submittingRef.current = true
    verifyingOtpRef.current = true
    const attempt = beginAttempt()
    let establishedSession: Session | null = null
    let retainedSession = false
    setError(null)
    setLoading(true)

    // 15-second timeout — OTP verification can hang on poor connections.
    const timeoutId = setTimeout(() => {
      if (!isAttemptCurrent(attempt)) return
      cancelAttempt(attempt)
      setError(t('loginTimeout'))
      setLoading(false)
      submittingRef.current = false
      verifyingOtpRef.current = false
    }, 15_000)

    try {
      const { data, error: verifyError } = await tokenRefreshCoordinator.verifyOtp({
        email,
        token: code,
        type: 'email',
      })
      establishedSession = data.session
      assertAttemptCurrent(attempt)
      clearTimeout(timeoutId)

      if (verifyError || !data.session) {
        if (isSupersededAuthError(verifyError)) throw new StaleLoginAttemptError()
        otpAttemptsRef.current += 1
        if (otpAttemptsRef.current >= 5) {
          setOtpLocked(true)
          setError(t('loginTooManyAttemptsCode'))
        } else if (
          verifyError?.message.includes('expired') ||
          verifyError?.message.includes('过期')
        ) {
          setError(t('loginCodeExpired'))
        } else {
          setError(t('loginVerificationFailed'))
        }
        return
      }

      const { identity, profile } = await loadAuthenticatedSession(attempt, data.session)
      if (isRegister) {
        registrationIdentityRef.current = identity
        retainedSession = true
        setCodeVerified(true)
        showToast(t('loginCodeVerified'), 'success')
      } else {
        commitLogin(attempt, identity, profile, { track: true })
        retainedSession = true
      }
    } catch (verifyFailure) {
      clearTimeout(timeoutId)
      const cancelled = isCancellation(verifyFailure)
      const message =
        verifyFailure instanceof Error &&
        (verifyFailure.message.includes('expired') || verifyFailure.message.includes('过期'))
          ? t('loginCodeExpired')
          : t('loginVerificationFailed')

      if (establishedSession && !retainedSession) {
        await rollbackSession(establishedSession, cancelled ? undefined : message)
      } else if (!cancelled && isAttemptCurrent(attempt)) {
        setError(message)
      }
    } finally {
      clearTimeout(timeoutId)
      if (isAttemptCurrent(attempt)) {
        setLoading(false)
        submittingRef.current = false
        verifyingOtpRef.current = false
      }
    }
  }

  const handleSetPassword = async () => {
    if (submittingRef.current || loading) return
    // Password floor: minimum 8 chars AND strength at least "fair" (level >= 2).
    // The strength meter is the real gate — block weak passwords, not just short ones.
    if (!password || password.length < 8 || getPasswordStrength(password).level < 2) {
      setError(t('loginPasswordMinLength'))
      return
    }
    const normalizedHandle = normalizeHandle(handle)
    const handleValidation = validateHandle(normalizedHandle)
    if (!handleValidation.valid) {
      setError(t(handleValidation.messageKey))
      return
    }
    if (normalizedHandle !== handle) setHandle(normalizedHandle)

    const registrationIdentity = registrationIdentityRef.current
    if (!registrationIdentity) {
      setError(t('loginVerificationFailed'))
      return
    }
    try {
      assertExactLoginIdentityCurrent(registrationIdentity)
    } catch {
      registrationIdentityRef.current = null
      codeVerifiedRef.current = false
      setCodeVerified(false)
      setError(t('loginVerificationFailed'))
      return
    }
    submittingRef.current = true
    const attempt = beginAttempt()
    let establishedSession: Session | null = null
    let completionCommitted = false
    setError(null)
    setLoading(true)

    const timeoutId = setTimeout(() => {
      if (!isAttemptCurrent(attempt)) return
      cancelAttempt(attempt)
      setError(t('loginTimeout'))
      setLoading(false)
      submittingRef.current = false
    }, 15_000)

    try {
      assertAttemptCurrent(attempt, registrationIdentity)
      const viewer = registrationIdentity.viewerScope
      if (!viewer) throw new StaleLoginAttemptError()

      const { data, error: updateError } = await tokenRefreshCoordinator.updateUserWithSession(
        { password },
        {
          expectedUserId: registrationIdentity.user.id,
          sessionGeneration: viewer.sessionGeneration,
        }
      )
      establishedSession = data.session
      assertAttemptCurrent(attempt)
      if (updateError || !data.session) {
        if (isSupersededAuthError(updateError)) throw new StaleLoginAttemptError()
        setError(t('loginVerificationFailed'))
        return
      }

      const identity = await verifyAttemptSession(attempt, data.session)
      if (identity.user.id !== registrationIdentity.user.id) throw new StaleLoginAttemptError()
      registrationIdentityRef.current = identity
      const profile = await synchronizeUserProfile(attempt, identity, normalizedHandle)
      assertAttemptCurrent(attempt, identity)
      const addedAccount = commitMultiAccount(attempt, identity, profile)
      assertAttemptCurrent(attempt, identity)

      // Count signup only after the trigger-provisioned profile and requested
      // handle have both committed under the exact verified session.
      trackEvent('signup')
      fireAndForget(
        exactSessionJsonRequest(identity, '/api/email/welcome', undefined, { keepalive: true }),
        'otp-signup-welcome-email'
      )

      // Brand-new email signup → route through the full activation flow while
      // preserving only a proven internal destination.
      const dest = addedAccount ? '/' : getRedirectUrl(normalizedHandle, identity.user.email)
      completionCommitted = true
      router.push(`/onboarding?returnUrl=${encodeURIComponent(dest)}`)
    } catch (err: unknown) {
      const profileError = err as { code?: string; message?: string }
      const cancelled = isCancellation(err)
      const mustRollback = cancelled || err instanceof MissingProvisionedProfileError
      if (establishedSession && !completionCommitted && mustRollback) {
        await rollbackSession(
          establishedSession,
          cancelled ? undefined : profileError?.message || t('loginSetupFailed')
        )
      } else if (!cancelled && isAttemptCurrent(attempt)) {
        if (profileError?.code === '23505') {
          setError(t('usernameInUse'))
        } else if (profileError?.code === '23514') {
          setError(t('loginHandleInvalidChars'))
        } else {
          setError(profileError?.message || t('loginSetupFailed'))
        }
      }
    } finally {
      clearTimeout(timeoutId)
      if (isAttemptCurrent(attempt)) {
        setLoading(false)
        submittingRef.current = false
      }
    }
  }

  const handleLogin = async () => {
    if (submittingRef.current || loading) return
    submittingRef.current = true
    const attempt = beginAttempt()
    let establishedSession: Session | null = null
    let completionCommitted = false
    setError(null)
    setLoading(true)

    // 10-second timeout — allows retry without page refresh
    const timeoutId = setTimeout(() => {
      if (!isAttemptCurrent(attempt)) return
      cancelAttempt(attempt)
      setError(t('loginTimeout'))
      setLoading(false)
      submittingRef.current = false
    }, 10_000)

    try {
      assertAttemptAuthBoundaryCurrent(attempt)
      // When adding a second account, sign out current session first
      if (isAddAccount) {
        await signOut()
        assertAttemptCurrent(attempt)
        const viewer = getViewerScope()
        const operation = getCurrentAuthOperation()
        if (
          !operation ||
          operation.identityTransition ||
          !operation.targetKnown ||
          operation.expectedUserId !== null ||
          viewer.viewerKey !== 'anon' ||
          viewer.userId !== null ||
          !isViewerScopeCurrent(viewer) ||
          getStoredAuthSession() !== null
        ) {
          throw new StaleLoginAttemptError()
        }
      }
      const { data, error: loginError } = await tokenRefreshCoordinator.signInWithPassword({
        email,
        password,
      })
      establishedSession = data.session
      assertAttemptCurrent(attempt)
      if (loginError || !data.session) {
        clearTimeout(timeoutId)
        if (isSupersededAuthError(loginError)) throw new StaleLoginAttemptError()
        const msg = loginError?.message || t('loginFailed')
        if (msg.includes('Invalid login credentials')) setError(t('loginIncorrectCredentials'))
        else if (msg.includes('Email not confirmed')) setError(t('loginEmailNotVerified'))
        else if (msg.includes('Too many requests') || msg.includes('rate limit')) {
          const RATE_LIMIT_SECONDS = 30
          setRateLimitCountdown(RATE_LIMIT_SECONDS)
          setError(t('loginRateLimitRetry').replace('{n}', String(RATE_LIMIT_SECONDS)))
        } else if (msg.toLowerCase().includes('banned')) {
          setError(t('loginAccountPendingDeletion'))
          setShowRecoveryPrompt(true)
        } else setError(msg)
        setLoading(false)
        return
      }
      clearTimeout(timeoutId)
      const { identity, profile } = await loadAuthenticatedSession(attempt, data.session)
      commitLogin(attempt, identity, profile, { track: true })
      completionCommitted = true
    } catch (err: unknown) {
      clearTimeout(timeoutId)
      const cancelled = isCancellation(err)
      const message = (err instanceof Error ? err.message : undefined) || t('loginFailed')
      if (establishedSession && !completionCommitted) {
        await rollbackSession(establishedSession, cancelled ? undefined : message)
      } else if (!cancelled && isAttemptCurrent(attempt)) {
        setError(message)
      }
    } finally {
      clearTimeout(timeoutId)
      if (isAttemptCurrent(attempt)) {
        setLoading(false)
        submittingRef.current = false
      }
    }
  }

  const resetForm = () => {
    cancelAttempt()
    registrationIdentityRef.current = null
    submittingRef.current = false
    verifyingOtpRef.current = false
    setCode('')
    setCodeSent(false)
    setCodeVerified(false)
    codeVerifiedRef.current = false
    setPassword('')
    setHandle('')
    setCountdown(0)
    safeSessionStorageRemove('otp_countdown_end')
    setError(null)
    setLoading(false)
    setSendingCode(false)
    setRecovering(false)
    setLoginWithCode(false)
    otpAttemptsRef.current = 0
    setOtpLocked(false)
    setShowRecoveryPrompt(false)
    setTouchedFields({ email: false, password: false, handle: false })
  }

  const handleRecoverAccount = async () => {
    if (recovering || (!accountRecoveryToken && (!email || !password))) return
    const attempt = beginAttempt()
    let establishedSession: Session | null = null
    let completionCommitted = false
    setRecovering(true)
    setError(null)
    try {
      const res = await fetch('/api/account/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          accountRecoveryToken ? { recovery_token: accountRecoveryToken } : { email, password }
        ),
        signal: attempt.controller.signal,
      })
      assertAttemptAuthBoundaryCurrent(attempt)
      const data = await res.json()
      assertAttemptAuthBoundaryCurrent(attempt)
      if (res.ok && data.success) {
        setShowRecoveryPrompt(false)
        showToast(t('loginAccountRecovered'), 'success')
        if (accountRecoveryToken) {
          safeLocalStorageRemove('arena_account_recovery_token')
          setAccountRecoveryToken(null)
          setError(null)
          return
        }
        // Now sign in normally since the ban has been lifted
        assertAttemptAuthBoundaryCurrent(attempt)
        submittingRef.current = true
        const { data: authData, error: loginError } =
          await tokenRefreshCoordinator.signInWithPassword({
            email,
            password,
          })
        establishedSession = authData.session
        assertAttemptCurrent(attempt)
        if (loginError || !authData.session) {
          if (isSupersededAuthError(loginError)) throw new StaleLoginAttemptError()
          setError(loginError?.message || t('loginFailed'))
        } else {
          const { identity, profile } = await loadAuthenticatedSession(attempt, authData.session)
          commitLogin(attempt, identity, profile, { track: true })
          completionCommitted = true
        }
      } else {
        setError(data.error || t('loginRecoveryFailed'))
      }
    } catch (err) {
      const cancelled = isCancellation(err)
      if (establishedSession && !completionCommitted) {
        await rollbackSession(establishedSession, cancelled ? undefined : t('networkErrorRetry'))
      } else if (!cancelled && isAttemptCurrent(attempt)) {
        logger.error('Account recovery error:', err)
        setError(t('networkErrorRetry'))
      }
    } finally {
      if (isAttemptCurrent(attempt)) {
        setRecovering(false)
        submittingRef.current = false
      }
    }
  }

  if (!mounted) return null

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div className="login-page-bg" />

      <div
        className="login-card"
        style={{
          maxWidth: 440,
          width: '100%',
          background: 'var(--color-bg-secondary, var(--color-backdrop-heavy))',
          border: '1px solid var(--color-accent-primary-15)',
          borderRadius: tokens.radius['3xl'],
          padding: 'clamp(24px, 5vw, 40px) clamp(20px, 4vw, 36px)',
          position: 'relative',
          zIndex: 1,
          boxShadow:
            '0 25px 50px -12px var(--color-overlay-dark), 0 0 80px var(--color-accent-primary-08)',
        }}
      >
        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1
            style={{
              fontSize: tokens.typography.fontSize['2xl'],
              fontWeight: tokens.typography.fontWeight.extrabold,
              marginBottom: 8,
              background:
                'linear-gradient(135deg, var(--color-text-primary) 0%, var(--color-brand-accent) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            {isRegister ? t('loginCreateAccount') : t('loginWelcomeBack')}
          </h1>
          <p style={{ fontSize: 14, color: tokens.colors.text.secondary, fontWeight: 500 }}>
            {t('loginSubtitle')}
          </p>
        </div>

        {/* Value / trust panel — reuses existing marketing copy keys */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginBottom: 24,
            padding: '14px 16px',
            borderRadius: tokens.radius.lg,
            background: 'var(--color-accent-primary-08)',
            border: '1px solid var(--color-accent-primary-15)',
          }}
        >
          {[
            t('loginValueProp1').replace(
              '{count}',
              formatRankedTraderCount(productFacts.rankedTraderCount, lang)
            ),
            t('loginValueProp2').replace('{count}', String(productFacts.exchangeCount)),
            t('loginValueProp3'),
          ].map((prop, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.medium,
                color: 'var(--color-text-secondary)',
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-accent-success)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{prop}</span>
            </div>
          ))}
        </div>

        {/* Social + Wallet — surfaced prominently (crypto audience converts here) */}
        <SocialLogin
          lang={lang}
          searchParams={searchParams}
          isAddAccount={isAddAccount}
          onError={(msg) => setError(msg || null)}
          onWalletSuccess={() => {
            showToast(t('loginWalletSignInSuccess'), 'success')
            // The exact SIGNED_IN session event owns profile/store/navigation.
          }}
          t={t}
        />
        {/* Divider — email/password is the secondary path */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0 16px' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--glass-border-light)' }} />
          <span
            style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}
          >
            {t('loginOrDivider')}
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--glass-border-light)' }} />
        </div>

        {/* Email input */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              marginBottom: 8,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
            }}
          >
            {t('loginEmail')}
          </label>
          <input
            type="email"
            className="login-input"
            style={{
              width: '100%',
              padding: '14px 16px',
              borderRadius: tokens.radius.lg,
              border: `1px solid ${touchedFields.email && !emailValidation.valid ? 'var(--color-accent-error)' : 'var(--glass-border-light)'}`,
              background: 'var(--color-bg-tertiary)',
              color: tokens.colors.text.primary,
              fontSize: 16,
              outline: 'none',
            }}
            placeholder="you@email.com"
            maxLength={254}
            value={email}
            onChange={(e) => {
              supersedeInteractiveAttempt()
              setEmail(e.target.value)
              if (isRegister) resetForm()
            }}
            onBlur={() => markTouched('email')}
            disabled={codeVerified}
            autoComplete="email"
            autoFocus
          />
          {touchedFields.email && email && !emailValidation.valid && (
            <div
              style={{ marginTop: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <span style={{ color: 'var(--color-accent-error)' }}>
                X - {t(emailValidation.messageKey)}
              </span>
            </div>
          )}
        </div>

        {/* Register / Login forms */}
        {isRegister ? (
          <RegisterForm
            email={email}
            password={password}
            setPassword={(value) => {
              supersedeInteractiveAttempt()
              setPassword(value)
            }}
            handle={handle}
            setHandle={(value) => {
              supersedeInteractiveAttempt()
              setHandle(value)
            }}
            code={code}
            setCode={(value) => {
              supersedeInteractiveAttempt()
              setCode(value)
            }}
            codeSent={codeSent}
            codeVerified={codeVerified}
            loading={loading}
            sendingCode={sendingCode}
            countdown={countdown}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            touchedFields={touchedFields}
            markTouched={markTouched}
            onSendCode={handleSendCode}
            onVerifyCode={handleVerifyCode}
            onResendCode={handleSendCode}
            onSetPassword={handleSetPassword}
            t={t}
          />
        ) : (
          <LoginForm
            email={email}
            password={password}
            setPassword={(value) => {
              supersedeInteractiveAttempt()
              setPassword(value)
            }}
            code={code}
            setCode={(value) => {
              supersedeInteractiveAttempt()
              setCode(value)
            }}
            loginWithCode={loginWithCode}
            codeSent={codeSent}
            loading={loading}
            sendingCode={sendingCode}
            countdown={countdown}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            touchedFields={touchedFields}
            markTouched={(f) => markTouched(f)}
            onLogin={handleLogin}
            onSendLoginCode={handleSendLoginCode}
            onVerifyCode={handleVerifyCode}
            onSwitchToCode={() => {
              supersedeInteractiveAttempt()
              trackEvent('login_switch_to_code')
              setLoginWithCode(true)
              setCodeSent(false)
              setCode('')
              setError(null)
            }}
            onSwitchToPassword={() => {
              supersedeInteractiveAttempt()
              trackEvent('login_switch_to_password')
              setLoginWithCode(false)
              setCodeSent(false)
              setCode('')
              setError(null)
            }}
            t={t}
            rateLimitCountdown={rateLimitCountdown}
          />
        )}

        {/* Switch login/register — hover + focus states handled in globals.css */}
        <button
          className="login-switch-btn"
          onClick={() => {
            trackEvent(isRegister ? 'login_switch_to_login' : 'login_switch_to_register')
            if (!isRegister) trackEvent('signup_start')
            setIsRegister(!isRegister)
            resetForm()
          }}
          style={{
            width: '100%',
            padding: '14px 16px',
            borderRadius: tokens.radius.lg,
            border: '1px solid var(--color-accent-primary-30)',
            background: 'transparent',
            color: 'var(--color-text-secondary)',
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
          }}
        >
          {isRegister ? t('loginSwitchToLogin') : t('loginSwitchToRegister')}
        </button>

        {/* Terms */}
        <p
          style={{
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--color-text-tertiary)',
            marginTop: 16,
            lineHeight: 1.6,
          }}
        >
          {t('loginTermsNote')}{' '}
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--color-brand)', textDecoration: 'none' }}
          >
            {t('termsOfService')}
          </a>{' '}
          {t('loginTermsAnd')}{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--color-brand)', textDecoration: 'none' }}
          >
            {t('privacyPolicy')}
          </a>
        </p>

        {/* Error message */}
        {error && (
          <div
            ref={errorRef}
            style={{
              marginTop: 20,
              padding: 14,
              borderRadius: tokens.radius.lg,
              background: 'var(--color-accent-error-10)',
              border: '1px solid var(--color-accent-error-20)',
              color: 'var(--color-accent-error)',
              fontSize: 13,
              fontWeight: 500,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ flexShrink: 0 }}
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {rateLimitCountdown > 0
                ? t('loginRateLimitRetry').replace('{n}', String(rateLimitCountdown))
                : error}
            </div>
            {showRecoveryPrompt && (
              <button
                onClick={handleRecoverAccount}
                disabled={recovering}
                style={{
                  padding: '10px 16px',
                  borderRadius: tokens.radius.md,
                  border: '1px solid var(--color-accent-success-40)',
                  background: 'var(--color-accent-success-10)',
                  color: 'var(--color-accent-success)',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: recovering ? 'wait' : 'pointer',
                  opacity: recovering ? 0.6 : 1,
                  transition: `all ${tokens.transition.base}`,
                }}
              >
                {recovering ? t('loginRecovering') : t('loginRecoverMyAccount')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
