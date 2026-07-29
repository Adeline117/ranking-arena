import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'

const mockAuthedFetch = jest.fn()
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | `user:${string}`
}

function signedIn(userId: string, token: string, generation: number): MockAuth {
  return {
    accessToken: token,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

function signedOut(generation: number): MockAuth {
  return {
    accessToken: null,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId: null,
    viewerKey: 'anon',
  }
}

let mockAuth: MockAuth = signedIn(VIEWER_A, 'access-token-a', 1)

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: (auth: MockAuth) => {
    if (
      auth.loading ||
      !auth.authChecked ||
      !auth.userId ||
      !auth.accessToken ||
      auth.viewerKey !== `user:${auth.userId}`
    ) {
      return null
    }
    return {
      accessToken: auth.accessToken,
      email: auth.email,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
      viewerKey: auth.viewerKey,
    }
  },
  isSettingsViewerCurrent: (
    viewer: { sessionGeneration: number; userId: string; viewerKey: string },
    auth: MockAuth
  ) =>
    auth.authChecked &&
    !auth.loading &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/layout/FloatingActionButton', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/LoadingSkeleton', () => ({
  __esModule: true,
  default: () => <div>loading-skeleton</div>,
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}))

import ReferralClient from '../ReferralClient'

function response(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
  }
}

type MockFetchResult = ReturnType<typeof response>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('ReferralClient viewer scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
  })

  it('never displays a late referral response from the previous viewer', async () => {
    const firstLoad = deferred<MockFetchResult>()
    mockAuthedFetch.mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce(
      response({
        referral_code: 'B-CODE',
        referral_count: 2,
        referral_link: 'https://arena.example/?ref=B-CODE',
      })
    )
    const view = render(<ReferralClient />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenNthCalledWith(
      1,
      '/api/referral',
      'GET',
      'access-token-a',
      undefined,
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    view.rerender(<ReferralClient />)
    expect(await screen.findByText('https://arena.example/?ref=B-CODE')).toBeInTheDocument()

    await act(async () => {
      firstLoad.resolve(
        response({
          referral_code: 'A-CODE',
          referral_count: 99,
          referral_link: 'https://arena.example/?ref=A-CODE',
        })
      )
      await firstLoad.promise
    })

    expect(screen.queryByText('https://arena.example/?ref=A-CODE')).not.toBeInTheDocument()
    expect(screen.getByText('https://arena.example/?ref=B-CODE')).toBeInTheDocument()
  })

  it('does not apply an old generate response after an account switch', async () => {
    const oldGenerate = deferred<MockFetchResult>()
    mockAuthedFetch
      .mockResolvedValueOnce(
        response({
          referral_code: '',
          referral_count: 0,
          referral_link: '',
        })
      )
      .mockReturnValueOnce(oldGenerate.promise)
      .mockResolvedValueOnce(
        response({
          referral_code: 'B-CODE',
          referral_count: 4,
          referral_link: 'https://arena.example/?ref=B-CODE',
        })
      )
    const view = render(<ReferralClient />)

    fireEvent.click(await screen.findByRole('button', { name: 'referralGenerate' }))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(mockAuthedFetch).toHaveBeenNthCalledWith(
      2,
      '/api/referral',
      'POST',
      'access-token-a',
      undefined,
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    view.rerender(<ReferralClient />)
    expect(await screen.findByText('https://arena.example/?ref=B-CODE')).toBeInTheDocument()

    await act(async () => {
      oldGenerate.resolve(
        response({
          referral_code: 'A-NEW',
          referral_link: 'https://arena.example/?ref=A-NEW',
        })
      )
      await oldGenerate.promise
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('https://arena.example/?ref=A-NEW')).not.toBeInTheDocument()
    expect(screen.getByText('https://arena.example/?ref=B-CODE')).toBeInTheDocument()
  })

  it('shows the sign-in gate without issuing a viewer-bound request', () => {
    mockAuth = signedOut(3)
    render(<ReferralClient />)

    expect(screen.getByText('referralSignInGateTitle')).toBeInTheDocument()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })
})
