import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ getAuthSession: jest.fn() }))
jest.mock('@/lib/supabase/client', () => ({ supabase: {} }))

import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getAuthSession } from '@/lib/auth'
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
    const auth = {
      authChecked: true,
      viewerKey: 'user:user-a',
      sessionGeneration: 1,
      userId: 'user-a',
    }
    mockUseAuthSession.mockImplementation(() => auth)
    const userBSession = deferred<{ userId: string; accessToken: string }>()
    mockGetAuthSession.mockImplementation(() =>
      auth.userId === 'user-b'
        ? userBSession.promise
        : Promise.resolve({ userId: 'user-a', accessToken: 'token-a' })
    )
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/membership/nft') {
        return { ok: true, json: async () => ({ hasNFT: false }) } as Response
      }
      const isUserA = new Headers(init?.headers).get('Authorization') === 'Bearer token-a'
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

    Object.assign(auth, {
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
      userId: 'user-b',
    })
    view.rerender(
      <PremiumProvider>
        <Probe />
      </PremiumProvider>
    )

    expect(screen.getByTestId('premium-state')).toHaveTextContent('loading:free:none')

    await act(async () => {
      userBSession.resolve({ userId: 'user-b', accessToken: 'token-b' })
    })
    await waitFor(() =>
      expect(screen.getByTestId('premium-state')).toHaveTextContent('ready:free:user-b')
    )
  })

  it('shows an NFT badge without converting a free viewer into Pro', async () => {
    mockUseAuthSession.mockReturnValue({
      authChecked: true,
      viewerKey: 'user:badge-owner',
      sessionGeneration: 1,
      userId: 'badge-owner',
    })
    mockGetAuthSession.mockResolvedValue({
      userId: 'badge-owner',
      accessToken: 'badge-token',
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
    mockUseAuthSession.mockReturnValue({
      authChecked: true,
      viewerKey: 'user:last-good',
      sessionGeneration: 1,
      userId: 'last-good',
    })
    mockGetAuthSession.mockResolvedValue({ userId: 'last-good', accessToken: 'last-good-token' })
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
    mockUseAuthSession.mockReturnValue({
      authChecked: true,
      viewerKey: 'user:unknown',
      sessionGeneration: 1,
      userId: 'unknown',
    })
    mockGetAuthSession.mockResolvedValue({ userId: 'unknown', accessToken: 'unknown-token' })
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
