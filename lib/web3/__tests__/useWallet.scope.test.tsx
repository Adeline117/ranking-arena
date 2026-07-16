import { act, renderHook, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import { useWallet } from '../useWallet'

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: jest.fn(),
}))

jest.mock('wagmi', () => ({
  useAccount: () => ({ address: null }),
}))

const mockUseAuthSession = useAuthSession as jest.Mock
const mockFetch = jest.fn()

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(payload: unknown, ok = true) {
  return {
    ok,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response
}

function authFor(userId: string, sessionGeneration: number) {
  return {
    accessToken: `token-${userId}`,
    authChecked: true,
    isLoggedIn: true,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

describe('useWallet viewer scope', () => {
  let currentAuth: ReturnType<typeof authFor>

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scopeA = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scopeA.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
    global.fetch = mockFetch
  })

  it('loads wallet and NFT state through the exact captured bearer token', async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        hasNft: true,
      })
    )

    const { result } = renderHook(() => useWallet())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.linkedAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(result.current.hasNFT).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith('/api/membership/nft', {
      headers: { Authorization: 'Bearer token-user-a' },
    })
  })

  it('discards a deferred A load and synchronously hides A while B resolves', async () => {
    const loadA = deferred<Response>()
    const loadB = deferred<Response>()
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('Authorization')
      if (authorization === 'Bearer token-user-a') return loadA.promise
      if (authorization === 'Bearer token-user-b') return loadB.promise
      throw new Error(`unexpected token: ${authorization}`)
    })

    const { result, rerender } = renderHook(() => useWallet())
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    rerender()

    // A is hidden from the render value before B's request settles.
    expect(result.current.linkedAddress).toBeNull()
    expect(result.current.hasNFT).toBe(false)
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))

    await act(async () => {
      loadA.resolve(
        response({
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          hasNft: true,
        })
      )
      await Promise.resolve()
    })
    expect(result.current.linkedAddress).toBeNull()

    await act(async () => {
      loadB.resolve(
        response({
          walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          hasNft: false,
        })
      )
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.linkedAddress).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(result.current.hasNFT).toBe(false)
  })

  it('never re-reads B auth when confirmation resolves for an A unlink', async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        hasNft: false,
      })
    )
    const { result, rerender } = renderHook(() => useWallet())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const operationA = result.current.captureWalletOperation()!

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    mockFetch.mockResolvedValueOnce(
      response({
        walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        hasNft: false,
      })
    )
    rerender()

    let success = true
    await act(async () => {
      success = await result.current.unlinkWallet(operationA)
    })

    expect(success).toBe(false)
    expect(mockFetch).not.toHaveBeenCalledWith('/api/auth/siwe/unlink', expect.anything())
    await waitFor(() =>
      expect(result.current.linkedAddress).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    )
  })

  it('does not let a deferred A unlink clear or toast for B', async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        hasNft: true,
      })
    )
    const { result, rerender } = renderHook(() => useWallet())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const operationA = result.current.captureWalletOperation()!

    const unlinkA = deferred<Response>()
    mockFetch.mockImplementationOnce((_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-user-a')
      return unlinkA.promise
    })

    let unlinkPromise!: Promise<boolean>
    act(() => {
      unlinkPromise = result.current.unlinkWallet(operationA)
    })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    mockFetch.mockResolvedValueOnce(
      response({
        walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        hasNft: false,
      })
    )
    rerender()
    await waitFor(() =>
      expect(result.current.linkedAddress).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    )

    let success = true
    await act(async () => {
      unlinkA.resolve(response({ success: true }))
      success = await unlinkPromise
    })

    expect(success).toBe(false)
    expect(result.current.linkedAddress).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  })
})

describe('WalletSection confirmation contract', () => {
  const walletHook = readFileSync(join(process.cwd(), 'lib/web3/useWallet.ts'), 'utf8')
  const walletSection = readFileSync(
    join(process.cwd(), 'app/components/settings/WalletSection.tsx'),
    'utf8'
  )

  it('uses canonical auth and never re-reads a mutable Supabase session', () => {
    expect(walletHook).toContain('useAuthSession()')
    expect(walletHook).not.toMatch(/supabase\.auth\.(?:getUser|getSession)\(/)
    expect(walletHook).toContain('operation.accessToken')
    expect(walletHook).toContain('isViewerScopeCurrent(operation)')
  })

  it('captures A before confirm and validates the viewer after every await', () => {
    const handler = walletSection.slice(
      walletSection.indexOf('const handleUnlinkWallet'),
      walletSection.indexOf('if (walletLoading)')
    )
    const capture = handler.indexOf('captureWalletOperation()')
    const confirm = handler.indexOf('await onConfirm')
    const afterConfirmCas = handler.indexOf('isWalletOperationCurrent(operation)', confirm)
    const unlink = handler.indexOf('await unlinkWallet(operation)')
    const afterUnlinkCas = handler.indexOf('isWalletOperationCurrent(operation)', unlink)

    expect(capture).toBeGreaterThanOrEqual(0)
    expect(capture).toBeLessThan(confirm)
    expect(afterConfirmCas).toBeGreaterThan(confirm)
    expect(afterConfirmCas).toBeLessThan(unlink)
    expect(afterUnlinkCas).toBeGreaterThan(unlink)
  })
})
