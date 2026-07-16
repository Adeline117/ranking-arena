import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockShowToast = jest.fn()
const mockGetCsrfHeaders = jest.fn(() => ({ 'X-CSRF-Token': 'csrf-token' }))

const translations: Record<string, string> = {
  adminLoadFailed: 'Failed to load',
  adminRejectReasonPlaceholder: 'Reject reason (optional)',
  all: 'All',
  approve: 'Approve',
  approved: 'Approved',
  cancel: 'Cancel',
  claimFailed: 'Claim failed',
  confirm: 'Confirm',
  loading: 'Loading',
  noClaims: 'No claims found',
  reject: 'Reject',
  rejected: 'Rejected',
  retry: 'Retry',
  traderClaims: 'Trader Claims',
}
const mockT = (key: string) => translations[key] ?? key

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockT }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => mockGetCsrfHeaders(),
}))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', props, children),
    Text: ({
      as,
      children,
      color: _color,
      size: _size,
      weight: _weight,
      ...props
    }: React.HTMLAttributes<HTMLElement> & {
      as?: keyof HTMLElementTagNameMap
      color?: string
      size?: string
      weight?: string
    }) => React.createElement(as || 'span', props, children),
    Button: ({
      children,
      loading,
      size: _size,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      loading?: boolean
      size?: string
      variant?: string
    }) =>
      React.createElement(
        'button',
        { ...props, disabled: props.disabled || loading, 'aria-busy': Boolean(loading) },
        children
      ),
  }
})

jest.mock('@/app/components/ui/Card', () => ({
  __esModule: true,
  default: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}))

jest.mock('@/app/components/ui/ErrorMessage', () => ({
  __esModule: true,
  default: ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
    <div role="alert">
      <span>{message}</span>
      {onRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  ),
}))

import TraderClaimsTab from '../TraderClaimsTab'

const mockFetch = jest.fn()

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

function claim(
  id: string,
  traderId: string,
  status: 'pending' | 'reviewing' | 'verified' | 'rejected' = 'pending'
) {
  return {
    id,
    user_id: `user-${id}`,
    trader_id: traderId,
    source: 'binance',
    handle: null,
    verification_method: 'api_key',
    status,
    reject_reason: null,
    created_at: '2026-07-16T10:00:00.000Z',
    verified_at: null,
  }
}

function claimsResponse(claims: ReturnType<typeof claim>[]) {
  return response({ data: { claims } })
}

describe('TraderClaimsTab review UX', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
  })

  it('shows a load error and recovers through the visible retry action', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ error: 'Claims service unavailable' }, 503))
      .mockResolvedValueOnce(claimsResponse([claim('claim-a', 'trader-a')]))

    render(<TraderClaimsTab accessToken="admin-token" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Claims service unavailable')
    expect(mockShowToast).toHaveBeenCalledWith('Claims service unavailable', 'error')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('trader-a')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('surfaces a review conflict inline and re-enables the action', async () => {
    mockFetch
      .mockResolvedValueOnce(claimsResponse([claim('claim-a', 'trader-a')]))
      .mockResolvedValueOnce(
        response({ error: { message: 'Trader identity is already claimed' } }, 409)
      )

    render(<TraderClaimsTab accessToken="admin-token" />)
    const approve = await screen.findByRole('button', { name: 'Approve' })

    fireEvent.click(approve)

    expect(await screen.findByRole('alert')).toHaveTextContent('Trader identity is already claimed')
    expect(mockShowToast).toHaveBeenCalledWith('Trader identity is already claimed', 'error')
    await waitFor(() => expect(approve).toBeEnabled())
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the committed terminal state when the follow-up refresh fails', async () => {
    mockFetch
      .mockResolvedValueOnce(claimsResponse([claim('claim-a', 'trader-a')]))
      .mockResolvedValueOnce(
        response({ success: true, data: { claim: claim('claim-a', 'trader-a', 'verified') } })
      )
      .mockResolvedValueOnce(response({ error: 'Refresh temporarily unavailable' }, 503))

    render(<TraderClaimsTab accessToken="admin-token" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Approved', 'success'))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    )
    expect(screen.getByText('verified')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Refresh temporarily unavailable')
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(mockFetch.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer admin-token',
        'X-CSRF-Token': 'csrf-token',
      }),
    })
  })

  it('keeps reviewing claims inside the pending filter', async () => {
    mockFetch.mockResolvedValueOnce(
      claimsResponse([
        claim('claim-a', 'pending-trader'),
        claim('claim-b', 'reviewing-trader', 'reviewing'),
        claim('claim-c', 'verified-trader', 'verified'),
      ])
    )

    render(<TraderClaimsTab accessToken="admin-token" />)
    await screen.findByText('verified-trader')

    fireEvent.click(screen.getByRole('button', { name: 'Pending (2)' }))

    expect(screen.getByText('pending-trader')).toBeInTheDocument()
    expect(screen.getByText('reviewing-trader')).toBeInTheDocument()
    expect(screen.queryByText('verified-trader')).not.toBeInTheDocument()
  })

  it('deduplicates rapid review clicks while the first request is in flight', async () => {
    let resolveReview!: (value: Response) => void
    const reviewResponse = new Promise<Response>((resolve) => {
      resolveReview = resolve
    })
    mockFetch
      .mockResolvedValueOnce(claimsResponse([claim('claim-a', 'trader-a')]))
      .mockReturnValueOnce(reviewResponse)
      .mockResolvedValueOnce(claimsResponse([claim('claim-a', 'trader-a', 'verified')]))

    render(<TraderClaimsTab accessToken="admin-token" />)
    const approve = await screen.findByRole('button', { name: 'Approve' })

    fireEvent.click(approve)
    fireEvent.click(approve)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    await act(async () =>
      resolveReview(
        response({
          success: true,
          data: { claim: claim('claim-a', 'trader-a', 'verified') },
        })
      )
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3))
  })
})
