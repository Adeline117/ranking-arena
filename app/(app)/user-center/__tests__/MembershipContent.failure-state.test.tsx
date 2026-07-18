import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockGetAuthHeadersAsync = jest.fn().mockResolvedValue({
  Authorization: 'Bearer access-token',
})

const translations: Record<string, string> = {
  loadFailedRetryShort: 'Failed to load, please retry',
  retry: 'Retry',
  somethingWentWrong: 'Something went wrong',
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => translations[key] ?? key,
  }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    authChecked: true,
    viewerKey: 'user:user-1',
    sessionGeneration: 1,
    userId: 'user-1',
    getAuthHeadersAsync: mockGetAuthHeadersAsync,
    getToken: jest.fn().mockResolvedValue('access-token'),
  }),
}))

jest.mock('@/lib/premium/hooks', () => ({
  usePremium: () => ({ isPremium: false }),
  FEATURE_LIMITS: {
    free: { maxFollows: 10 },
    pro: { maxFollows: 100 },
  },
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: jest.fn(),
}))

jest.mock('@/lib/api/client', () => ({
  apiRequest: jest.fn(),
}))

jest.mock('../CurrentPlanCard', () => ({
  __esModule: true,
  default: () => <div>Current plan loaded</div>,
}))

jest.mock('../UpgradeSection', () => ({
  __esModule: true,
  default: () => <div>Upgrade plans loaded</div>,
}))

jest.mock('../ProFeaturesList', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('../NftMembershipCard', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('../ComparisonTable', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('../UsageStatsCard', () => ({
  __esModule: true,
  default: () => <div>Usage loaded</div>,
}))

jest.mock('../FaqSection', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('../SubscriptionManagement', () => ({
  __esModule: true,
  default: () => null,
}))

import MembershipContent from '../MembershipContent'

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

function successfulResponse(input: RequestInfo | URL): Promise<Response> {
  const url = String(input)
  if (url === '/api/subscription') {
    return Promise.resolve(response({ subscription: null }))
  }
  if (url === '/api/membership/nft') {
    return Promise.resolve(response({ hasNft: false }))
  }
  return Promise.resolve(response({ followedTraders: 2, apiCallsToday: 3 }))
}

describe('MembershipContent failure state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('fails closed instead of rendering a false free plan when a membership request fails', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/subscription') {
        return Promise.resolve(response({ error: 'Service unavailable' }, 503))
      }
      return successfulResponse(input)
    })

    render(<MembershipContent />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load, please retry')
    expect(screen.queryByText('Current plan loaded')).not.toBeInTheDocument()
    expect(screen.queryByText('Upgrade plans loaded')).not.toBeInTheDocument()
    expect(screen.queryByText('Usage loaded')).not.toBeInTheDocument()
  })

  it('recovers all membership data after retry', async () => {
    let failed = true
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (failed && String(input) === '/api/subscription') {
        return Promise.resolve(response({ error: 'Service unavailable' }, 503))
      }
      return successfulResponse(input)
    })

    render(<MembershipContent />)

    const retry = await screen.findByRole('button', { name: 'Retry' })
    failed = false
    fireEvent.click(retry)

    await waitFor(() => expect(screen.getByText('Current plan loaded')).toBeInTheDocument())
    expect(screen.getByText('Upgrade plans loaded')).toBeInTheDocument()
    expect(screen.getByText('Usage loaded')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(6)
  })

  it('treats a generic network failure as a retryable error', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))

    render(<MembershipContent />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load, please retry')
    expect(screen.queryByText('Current plan loaded')).not.toBeInTheDocument()
  })
})
