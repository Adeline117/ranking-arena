import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockSignInWithOtp = jest.fn()
const mockProfileMaybeSingle = jest.fn()
const mockVerifyOtp = jest.fn()
const mockSignOutIfCurrent = jest.fn()
const mockVerifySessionSnapshot = jest.fn()
const mockAssertSnapshotCurrent = jest.fn()
const mockIsSnapshotCurrent = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      signInWithOAuth: jest.fn(),
      signInWithOtp: (...args: unknown[]) => mockSignInWithOtp(...args),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ maybeSingle: mockProfileMaybeSingle }),
      }),
    })),
  },
}))
jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
    signOutIfCurrent: (...args: unknown[]) => mockSignOutIfCurrent(...args),
  },
}))
jest.mock('@/lib/auth/verified-session', () => {
  const actual = jest.requireActual('@/lib/auth/verified-session')
  return {
    ...actual,
    verifySessionSnapshot: (...args: unknown[]) => mockVerifySessionSnapshot(...args),
    assertVerifiedSessionSnapshotCurrent: (...args: unknown[]) =>
      mockAssertSnapshotCurrent(...args),
    isVerifiedSessionSnapshotCurrent: (...args: unknown[]) => mockIsSnapshotCurrent(...args),
  }
})
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/ModalOverlay', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}))
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default:
    () =>
    ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

import type { Session, User } from '@supabase/supabase-js'
import { StaleVerifiedSessionError } from '@/lib/auth/verified-session'
import LoginModal from '../LoginModal'

function session(userId = 'user-a'): Session {
  return {
    access_token: `access-${userId}`,
    refresh_token: `refresh-${userId}`,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: userId, email: `${userId}@example.com` } as User,
  }
}

function snapshotFor(value: Session) {
  return {
    session: value,
    user: value.user,
    authOperation: { id: 'operation-a' },
    viewerScope: {
      viewerKey: `user:${value.user.id}`,
      userId: value.user.id,
      sessionGeneration: 1,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function reachOtpStep() {
  fireEvent.click(screen.getByRole('button', { name: 'authEmailCode' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'authEnterEmail' }), {
    target: { value: 'a@example.com' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'authSendCode' }))
  await screen.findByRole('textbox', { name: 'authEnterCode' })
  fireEvent.change(screen.getByRole('textbox', { name: 'authEnterCode' }), {
    target: { value: '123456' },
  })
}

describe('LoginModal provisioned identity boundary', () => {
  const onClose = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    const verifiedSession = session()
    mockSignInWithOtp.mockResolvedValue({ error: null })
    mockVerifyOtp.mockResolvedValue({
      data: { session: verifiedSession, user: verifiedSession.user },
      error: null,
    })
    mockVerifySessionSnapshot.mockResolvedValue(snapshotFor(verifiedSession))
    mockIsSnapshotCurrent.mockReturnValue(true)
    mockProfileMaybeSingle.mockResolvedValue({ data: { handle: 'user-a' }, error: null })
    mockSignOutIfCurrent.mockResolvedValue(true)
  })

  it('distinguishes legal links without relying on color alone', () => {
    render(<LoginModal open onClose={onClose} />)

    expect(screen.getByRole('link', { name: 'termsOfService' })).toHaveStyle({
      textDecoration: 'underline',
    })
    expect(screen.getByRole('link', { name: 'privacyPolicy' })).toHaveStyle({
      textDecoration: 'underline',
    })
  })

  it('closes only after the exact session and required profile are verified', async () => {
    render(<LoginModal open onClose={onClose} />)
    await reachOtpStep()

    fireEvent.click(screen.getByRole('button', { name: 'authVerify' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(mockVerifySessionSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ access_token: 'access-user-a' })
    )
    expect(mockAssertSnapshotCurrent).toHaveBeenCalled()
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
  })

  it('rolls back only the session created by this attempt when its profile is missing', async () => {
    mockProfileMaybeSingle.mockResolvedValue({ data: null, error: null })
    render(<LoginModal open onClose={onClose} />)
    await reachOtpStep()

    fireEvent.click(screen.getByRole('button', { name: 'authVerify' }))

    await screen.findByText('loadUserDataFailed')
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith('user-a', 'access-user-a')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('rolls back a completed A login when the modal unmounts before verification finishes', async () => {
    const verification = deferred<ReturnType<typeof snapshotFor>>()
    mockVerifySessionSnapshot.mockReturnValue(verification.promise)
    const view = render(<LoginModal open onClose={onClose} />)
    await reachOtpStep()
    fireEvent.click(screen.getByRole('button', { name: 'authVerify' }))
    await waitFor(() => expect(mockVerifySessionSnapshot).toHaveBeenCalledTimes(1))

    view.unmount()
    await act(async () => verification.resolve(snapshotFor(session())))

    expect(mockSignOutIfCurrent).toHaveBeenCalledWith('user-a', 'access-user-a')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not surface an old A failure after a newer auth operation supersedes it', async () => {
    mockVerifySessionSnapshot.mockRejectedValue(new StaleVerifiedSessionError())
    const view = render(<LoginModal open onClose={onClose} />)
    await reachOtpStep()

    fireEvent.click(screen.getByRole('button', { name: 'authVerify' }))

    await waitFor(() =>
      expect(mockSignOutIfCurrent).toHaveBeenCalledWith('user-a', 'access-user-a')
    )
    expect(screen.queryByText('loadUserDataFailed')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(view.container).not.toBeEmptyDOMElement()
  })

  it('does not attach a plain A profile failure to a newer B viewer', async () => {
    mockProfileMaybeSingle.mockResolvedValue({ data: null, error: null })
    mockIsSnapshotCurrent.mockReturnValue(false)
    mockSignOutIfCurrent.mockResolvedValue(false)
    render(<LoginModal open onClose={onClose} />)
    await reachOtpStep()

    fireEvent.click(screen.getByRole('button', { name: 'authVerify' }))

    await waitFor(() =>
      expect(mockSignOutIfCurrent).toHaveBeenCalledWith('user-a', 'access-user-a')
    )
    expect(screen.queryByText('loadUserDataFailed')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
