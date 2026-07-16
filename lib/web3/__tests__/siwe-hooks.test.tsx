import { act, renderHook, waitFor } from '@testing-library/react'

const WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'
const SECOND_WALLET_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

const mockUseAccount = jest.fn()
const mockSignMessageAsync = jest.fn()
jest.mock('wagmi', () => ({
  useAccount: () => mockUseAccount(),
  useSignMessage: () => ({ signMessageAsync: mockSignMessageAsync }),
}))

const mockOpenConnectModal = jest.fn()
jest.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => ({ openConnectModal: mockOpenConnectModal }),
}))

jest.mock('siwe', () => ({
  SiweMessage: jest.fn().mockImplementation(() => ({
    prepareMessage: () => 'prepared-siwe-message',
  })),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

const mockGetToken = jest.fn()
const mockSignOut = jest.fn()
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    email: null,
    getToken: mockGetToken,
    signOut: mockSignOut,
  }),
}))

const mockEstablishRequiredSiweSession = jest.fn()
const mockRollbackSiweSessionIfCurrent = jest.fn()
jest.mock('@/lib/web3/siwe-session', () => {
  const actual = jest.requireActual('@/lib/web3/siwe-session')
  return {
    ...actual,
    establishRequiredSiweSession: (...args: unknown[]) => mockEstablishRequiredSiweSession(...args),
    rollbackSiweSessionIfCurrent: (...args: unknown[]) => mockRollbackSiweSessionIfCurrent(...args),
  }
})

import { useOneClickSiwe } from '../useOneClickSiwe'
import { useSiweAuth } from '../useSiweAuth'

const validResult = {
  action: 'existing_user' as const,
  userId: 'user-1',
  handle: 'wallet-user',
  walletAddress: WALLET_ADDRESS,
  verificationToken: 'verification-token',
  email: 'wallet@wallet.arena',
}
const completedSession = {
  snapshot: {
    user: { id: 'user-1' },
    session: { access_token: 'completed-access-token' },
  },
  profile: { handle: 'wallet-user', avatar_url: null },
}

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  }
}

function queueSuccessfulServerVerification(body: unknown = validResult) {
  const fetchMock = global.fetch as jest.Mock
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ nonce: 'nonce' }))
    .mockResolvedValueOnce(jsonResponse(body))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('SIWE hooks fail-closed completion contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn() as unknown as typeof fetch
    mockUseAccount.mockReturnValue({
      address: WALLET_ADDRESS,
      chainId: 8453,
      isConnected: true,
      isConnecting: false,
    })
    mockSignMessageAsync.mockResolvedValue('0xsigned')
    mockEstablishRequiredSiweSession.mockResolvedValue(completedSession)
    mockRollbackSiweSessionIfCurrent.mockResolvedValue(false)
  })

  it('does not let one-click SIWE report success when token or email is missing', async () => {
    queueSuccessfulServerVerification({ ...validResult, email: undefined })
    const onSuccess = jest.fn()
    const onError = jest.fn()
    const { result } = renderHook(() => useOneClickSiwe({ onSuccess, onError }))

    let returned: unknown
    await act(async () => {
      returned = await result.current.signIn()
    })

    expect(returned).toBeNull()
    expect(result.current.status).toBe('error')
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
    expect(mockEstablishRequiredSiweSession).not.toHaveBeenCalled()
  })

  it('waits for required session/profile completion before one-click success', async () => {
    queueSuccessfulServerVerification()
    const completion = deferred<unknown>()
    mockEstablishRequiredSiweSession.mockReturnValue(completion.promise)
    const onSuccess = jest.fn()
    const { result } = renderHook(() => useOneClickSiwe({ onSuccess }))

    let signInPromise!: Promise<unknown>
    act(() => {
      signInPromise = result.current.signIn()
    })
    await waitFor(() => expect(mockEstablishRequiredSiweSession).toHaveBeenCalledTimes(1))
    expect(onSuccess).not.toHaveBeenCalled()
    expect(result.current.status).toBe('verifying')

    await act(async () => {
      completion.resolve(completedSession)
      await signInPromise
    })

    expect(onSuccess).toHaveBeenCalledWith(validResult)
    expect(result.current.status).toBe('success')
  })

  it('does not let one-click SIWE report success when session completion fails', async () => {
    queueSuccessfulServerVerification()
    mockEstablishRequiredSiweSession.mockRejectedValue(new Error('profile missing'))
    const onSuccess = jest.fn()
    const { result } = renderHook(() => useOneClickSiwe({ onSuccess }))

    let returned: unknown
    await act(async () => {
      returned = await result.current.signIn()
    })

    expect(returned).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(result.current.status).toBe('error')
  })

  it('does not return a useSiweAuth result when session/profile completion fails', async () => {
    queueSuccessfulServerVerification()
    mockEstablishRequiredSiweSession.mockRejectedValue(new Error('OTP failed'))
    const { result } = renderHook(() => useSiweAuth())

    let returned: unknown
    await act(async () => {
      returned = await result.current.signIn()
    })

    expect(returned).toBeNull()
    expect(result.current.error).toBeTruthy()
  })

  it('returns the verified useSiweAuth result only after required completion', async () => {
    queueSuccessfulServerVerification()
    const { result } = renderHook(() => useSiweAuth())

    let returned: unknown
    await act(async () => {
      returned = await result.current.signIn()
    })

    expect(mockEstablishRequiredSiweSession).toHaveBeenCalledWith(
      validResult,
      expect.objectContaining({
        expectedWalletAddress: WALLET_ADDRESS,
        signal: expect.any(Object),
        isCurrent: expect.any(Function),
      })
    )
    expect(returned).toEqual(validResult)
    expect(result.current.error).toBeNull()
  })

  it('rolls back and suppresses one-click success when unmounted during completion', async () => {
    queueSuccessfulServerVerification()
    const completion = deferred<unknown>()
    mockEstablishRequiredSiweSession.mockReturnValue(completion.promise)
    const onSuccess = jest.fn()
    const onError = jest.fn()
    const { result, unmount } = renderHook(() => useOneClickSiwe({ onSuccess, onError }))

    let signInPromise!: Promise<unknown>
    act(() => {
      signInPromise = result.current.signIn()
    })
    await waitFor(() => expect(mockEstablishRequiredSiweSession).toHaveBeenCalledTimes(1))

    unmount()
    let returned: unknown
    await act(async () => {
      completion.resolve(completedSession)
      returned = await signInPromise
    })

    expect(returned).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(mockRollbackSiweSessionIfCurrent).toHaveBeenCalledWith(
      'user-1',
      'completed-access-token'
    )
  })

  it('invalidates an A sign-in when the wallet switches to B during completion', async () => {
    queueSuccessfulServerVerification()
    const completion = deferred<unknown>()
    mockEstablishRequiredSiweSession.mockReturnValue(completion.promise)
    const { result, rerender } = renderHook(() => useSiweAuth())

    let signInPromise!: Promise<unknown>
    act(() => {
      signInPromise = result.current.signIn()
    })
    await waitFor(() => expect(mockEstablishRequiredSiweSession).toHaveBeenCalledTimes(1))

    mockUseAccount.mockReturnValue({
      address: SECOND_WALLET_ADDRESS,
      chainId: 8453,
      isConnected: true,
      isConnecting: false,
    })
    rerender()

    let returned: unknown
    await act(async () => {
      completion.resolve(completedSession)
      returned = await signInPromise
    })

    expect(returned).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.isLoading).toBe(false)
    expect(mockRollbackSiweSessionIfCurrent).toHaveBeenCalledWith(
      'user-1',
      'completed-access-token'
    )
  })

  it('rejects a link response for a wallet other than the signed wallet', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ nonce: 'nonce' }))
      .mockResolvedValueOnce(jsonResponse({ walletAddress: SECOND_WALLET_ADDRESS }))
    mockGetToken.mockResolvedValue('access-token')
    const { result } = renderHook(() => useSiweAuth())

    let returned: unknown
    await act(async () => {
      returned = await result.current.linkWallet()
    })

    expect(returned).toBeNull()
    expect(result.current.error).toBeTruthy()
  })
})
