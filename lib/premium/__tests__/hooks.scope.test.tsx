import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ getAuthSession: jest.fn() }))
jest.mock('@/lib/supabase/client', () => ({ supabase: {} }))

import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getAuthSession } from '@/lib/auth'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'
import { PremiumProvider, usePremium, usePremiumProviderPresent } from '../hooks'

const mockUseAuthSession = useAuthSession as jest.Mock
const mockGetAuthSession = getAuthSession as jest.Mock

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function Probe() {
  const premium = usePremium()
  return (
    <>
      <div data-testid="premium-state">
        {premium.isLoading ? 'loading' : 'ready'}:{premium.tier}:
        {premium.subscription?.userId || 'none'}:{premium.error ? 'error' : 'ok'}
      </div>
      <button type="button" onClick={() => void premium.refresh()}>
        refresh
      </button>
    </>
  )
}

function BadgeProbe() {
  const premium = usePremium()
  return (
    <div data-testid="badge-state">
      {premium.isLoading ? 'loading' : 'ready'}:{premium.tier}:{premium.source}:
      {premium.hasNFT ? 'badge' : 'no-badge'}
    </div>
  )
}

function ProviderPresenceProbe() {
  return (
    <div data-testid="provider-presence">{usePremiumProviderPresent() ? 'present' : 'absent'}</div>
  )
}

describe('PremiumProvider viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
  })

  it('distinguishes the provider-light homepage from a loading provider', () => {
    mockUseAuthSession.mockReturnValue({
      authChecked: false,
      viewerKey: 'pending',
      sessionGeneration: 0,
      userId: null,
    })

    const view = render(<ProviderPresenceProbe />)
    expect(screen.getByTestId('provider-presence')).toHaveTextContent('absent')

    view.rerender(
      <PremiumProvider>
        <ProviderPresenceProbe />
      </PremiumProvider>
    )
    expect(screen.getByTestId('provider-presence')).toHaveTextContent('present')
  })

  it('fails empty on the first B render and discards A-owned entitlement state', async () => {
    const userAScope = synchronizeViewerScope(true, 'user-a')
    const auth = {
      authChecked: true,
      viewerKey: 'user:user-a',
      sessionGeneration: userAScope.sessionGeneration,
      userId: 'user-a',
    }
    mockUseAuthSession.mockImplementation(() => auth)
    const userBSession = deferred<{ userId: string; accessToken: string }>()
    mockGetAuthSession.mockImplementation(() =>
      auth.userId === 'user-b'
        ? userBSession.promise
        : Promise.resolve({ userId: 'user-a', accessToken: jwt('user-a') })
    )
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/membership/nft') {
        return { ok: true, json: async () => ({ hasNFT: false }) } as Response
      }
      const isUserA = new Headers(init?.headers).get('Authorization') === `Bearer ${jwt('user-a')}`
      return {
        ok: true,
        json: async () => ({
          subscription: {
            userId: isUserA ? 'user-a' : 'user-b',
            tier: isUserA ? 'pro' : 'free',
            status: 'active',
            startDate: '2026-07-15T00:00:00.000Z',
            endDate: null,
            trialEndDate: null,
            autoRenew: false,
            usage: {
              apiCallsToday: 0,
              comparisonReportsThisMonth: 0,
              exportsThisMonth: 0,
              currentFollows: 0,
              currentCustomRankings: 0,
            },
          },
        }),
      } as Response
    })

    const view = render(
      <PremiumProvider>
        <Probe />
      </PremiumProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId('premium-state')).toHaveTextContent('ready:pro:user-a')
    )

    const userBScope = synchronizeViewerScope(true, 'user-b')
    Object.assign(auth, {
      viewerKey: 'user:user-b',
      sessionGeneration: userBScope.sessionGeneration,
      userId: 'user-b',
    })
    view.rerender(
      <PremiumProvider>
        <Probe />
      </PremiumProvider>
    )

    expect(screen.getByTestId('premium-state')).toHaveTextContent('loading:free:none')

    await act(async () => {
      userBSession.resolve({ userId: 'user-b', accessToken: jwt('user-b') })
    })
    await waitFor(() =>
      expect(screen.getByTestId('premium-state')).toHaveTextContent('ready:free:user-b')
    )
  })

  it('shows an NFT badge without converting a free viewer into Pro', async () => {
    const scope = synchronizeViewerScope(true, 'badge-owner')
    mockUseAuthSession.mockReturnValue({
      authChecked: true,
      viewerKey: 'user:badge-owner',
      sessionGeneration: scope.sessionGeneration,
      userId: 'badge-owner',
    })
    mockGetAuthSession.mockResolvedValue({
      userId: 'badge-owner',
      accessToken: jwt('badge-owner'),
    })
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/membership/nft') {
        return { ok: true, json: async () => ({ hasNft: true }) } as Response
      }
      return {
        ok: true,
        json: async () => ({
          subscription: {
            userId: 'badge-owner',
            tier: 'free',
            status: 'active',
            startDate: '2026-07-18T00:00:00.000Z',
            endDate: null,
            trialEndDate: null,
            autoRenew: false,
            usage: {
              apiCallsToday: 0,
              comparisonReportsThisMonth: 0,
              exportsThisMonth: 0,
              currentFollows: 0,
              currentCustomRankings: 0,
            },
          },
        }),
      } as Response
    })

    render(
      <PremiumProvider>
        <BadgeProbe />
      </PremiumProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('badge-state')).toHaveTextContent('ready:free:free:badge')
    )
  })

  it('keeps same-viewer last-good Pro when a refresh cannot verify authority', async () => {
    const scope = synchronizeViewerScope(true, 'last-good')
    mockUseAuthSession.mockReturnValue({
      authChecked: true,
      viewerKey: 'user:last-good',
      sessionGeneration: scope.sessionGeneration,
      userId: 'last-good',
    })
    mockGetAuthSession.mockResolvedValue({
      userId: 'last-good',
      accessToken: jwt('last-good'),
    })
    let unavailable = false
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/membership/nft') {
        return { ok: true, json: async () => ({ hasNft: false }) } as Response
      }
      if (unavailable) {
        return { ok: false, status: 503, json: async () => ({ error: 'offline' }) } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          subscription: {
            userId: 'last-good',
            tier: 'pro',
            status: 'active',
            startDate: '2026-07-15T00:00:00.000Z',
            endDate: null,
            trialEndDate: null,
            autoRenew: false,
            usage: {
              apiCallsToday: 0,
              comparisonReportsThisMonth: 0,
              exportsThisMonth: 0,
              currentFollows: 0,
              currentCustomRankings: 0,
            },
          },
        }),
      } as Response
    })

    render(
      <PremiumProvider>
        <Probe />
      </PremiumProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId('premium-state')).toHaveTextContent('ready:pro:last-good:ok')
    )

    unavailable = true
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }))

    await waitFor(() =>
      expect(screen.getByTestId('premium-state')).toHaveTextContent('ready:pro:last-good:error')
    )
  })

  it('reports unknown entitlement instead of fabricating Free on the first failed read', async () => {
    const scope = synchronizeViewerScope(true, 'unknown')
    mockUseAuthSession.mockReturnValue({
      authChecked: true,
      viewerKey: 'user:unknown',
      sessionGeneration: scope.sessionGeneration,
      userId: 'unknown',
    })
    mockGetAuthSession.mockResolvedValue({ userId: 'unknown', accessToken: jwt('unknown') })
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/membership/nft') {
        return { ok: true, json: async () => ({ hasNft: false }) } as Response
      }
      return { ok: false, status: 503, json: async () => ({ error: 'offline' }) } as Response
    })

    render(
      <PremiumProvider>
        <Probe />
      </PremiumProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('premium-state')).toHaveTextContent('ready:free:none:error')
    )
  })
})
