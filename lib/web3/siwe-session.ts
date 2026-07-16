import type { VerifiedSessionSnapshot } from '@/lib/auth/verified-session'
import {
  assertVerifiedSessionSnapshotCurrent,
  verifySessionSnapshot,
} from '@/lib/auth/verified-session'
import { requireProvisionedProfile } from '@/lib/auth/profile-provisioning'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import { supabase } from '@/lib/supabase/client'
import { isAddress } from 'viem'

export interface SiweAuthResult {
  action: 'existing_user' | 'new_user'
  userId: string
  handle?: string
  walletAddress: string
  verificationToken: string
  email: string
}

export interface CompletedSiweSession {
  snapshot: VerifiedSessionSnapshot
  profile: {
    handle: string | null
    avatar_url: string | null
  }
}

export interface SiweSessionCompletionOptions {
  expectedWalletAddress: string
  signal?: AbortSignal
  isCurrent?: () => boolean
}

export class SiweSessionCompletionError extends Error {
  constructor(message = 'Wallet session could not be established') {
    super(message)
    this.name = 'SiweSessionCompletionError'
  }
}

export class SiweSessionCancelledError extends Error {
  constructor() {
    super('Wallet authentication attempt was cancelled')
    this.name = 'SiweSessionCancelledError'
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** Validate the untrusted JSON returned by the SIWE verification endpoint. */
export function parseSiweAuthResult(value: unknown): SiweAuthResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SiweSessionCompletionError('Invalid wallet verification response')
  }

  const candidate = value as Record<string, unknown>
  const action = candidate.action
  const userId = requiredString(candidate.userId)
  const walletAddress = requiredString(candidate.walletAddress)
  const verificationToken = requiredString(candidate.verificationToken)
  const email = requiredString(candidate.email)
  const handle = candidate.handle

  if (
    (action !== 'existing_user' && action !== 'new_user') ||
    !userId ||
    !walletAddress ||
    !verificationToken ||
    !email ||
    (handle !== null && handle !== undefined && typeof handle !== 'string')
  ) {
    throw new SiweSessionCompletionError('Invalid wallet verification response')
  }

  return {
    action,
    userId,
    ...(typeof handle === 'string' ? { handle } : {}),
    walletAddress,
    verificationToken,
    email,
  }
}

function assertCompletionCurrent(options: SiweSessionCompletionOptions): void {
  let current = true
  try {
    current = options.isCurrent?.() !== false
  } catch {
    current = false
  }
  if (options.signal?.aborted || !current) throw new SiweSessionCancelledError()
}

export function assertExpectedSiweWalletAddress(
  resultAddress: string,
  expectedAddress: string
): void {
  if (
    !isAddress(resultAddress) ||
    !isAddress(expectedAddress) ||
    resultAddress.toLowerCase() !== expectedAddress.toLowerCase()
  ) {
    throw new SiweSessionCompletionError('Wallet verification identity changed')
  }
}

/**
 * Roll back only while this exact SIWE principal still owns the viewer. Calling
 * coordinator.signOut starts synchronously, so a superseding B viewer can never
 * be logged out by a late A completion that already observes B here.
 */
export async function rollbackSiweSessionIfCurrent(
  userId: string,
  accessToken?: string
): Promise<boolean> {
  const scope = getViewerScope()
  if (scope.userId !== userId || !isViewerScopeCurrent(scope)) return false
  return tokenRefreshCoordinator.signOutIfCurrent(userId, accessToken)
}

/**
 * Exchange the one-time SIWE token, bind it to the exact expected auth user,
 * and require the trigger-provisioned application profile before callers may
 * announce success or navigate.
 */
export async function establishRequiredSiweSession(
  untrustedResult: unknown,
  options: SiweSessionCompletionOptions
): Promise<CompletedSiweSession> {
  const result = parseSiweAuthResult(untrustedResult)
  assertExpectedSiweWalletAddress(result.walletAddress, options.expectedWalletAddress)
  assertCompletionCurrent(options)

  let establishedExpectedSession = false
  let establishedAccessToken: string | undefined
  try {
    const { data, error } = await tokenRefreshCoordinator.verifyOtp(
      {
        email: result.email,
        token: result.verificationToken,
        type: 'email',
      },
      result.userId
    )

    if (
      error ||
      !data.session ||
      !data.user ||
      data.user.id !== result.userId ||
      data.session.user.id !== result.userId
    ) {
      throw new SiweSessionCompletionError()
    }
    establishedExpectedSession = true
    establishedAccessToken = data.session.access_token
    assertCompletionCurrent(options)

    const snapshot = await verifySessionSnapshot(supabase, data.session)
    assertCompletionCurrent(options)
    if (snapshot.user.id !== result.userId) {
      throw new SiweSessionCompletionError('Wallet session identity changed')
    }

    const { data: profileData, error: profileError } = await supabase
      .from('user_profiles')
      .select('handle, avatar_url')
      .eq('id', result.userId)
      .maybeSingle()
    assertCompletionCurrent(options)
    const profile = requireProvisionedProfile(profileData, profileError)
    assertVerifiedSessionSnapshotCurrent(snapshot)
    assertCompletionCurrent(options)

    return { snapshot, profile }
  } catch (error) {
    if (establishedExpectedSession) {
      try {
        await rollbackSiweSessionIfCurrent(result.userId, establishedAccessToken)
      } catch {
        // Preserve the original completion failure. The coordinator owns any
        // sign-out diagnostics and its fail-closed storage transition.
      }
    }
    throw error
  }
}
