import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import SubscriptionManagement from '../SubscriptionManagement'

const mockShowToast = jest.fn()
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf-test' }),
}))

const info = {
  subscription: {
    tier: 'pro' as const,
    status: 'active',
    plan: 'monthly',
    cancelAtPeriodEnd: false,
  },
  nft: null,
  usage: {
    followedTraders: 0,
    apiCallsToday: 0,
  },
}

const getAuthHeadersAsync = jest.fn(async () => ({ Authorization: 'Bearer exact-user' }))
const t = (key: string) => key

function renderManagement() {
  return render(
    <SubscriptionManagement
      info={info}
      cardStyle={{}}
      getAuthHeadersAsync={getAuthHeadersAsync}
      t={t}
    />
  )
}

describe('SubscriptionManagement Billing Portal flows', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: jest.fn().mockResolvedValue({ error: 'unavailable' }),
    }) as jest.Mock
  })

  it('offers only the explicit payment-method and cancellation actions', async () => {
    renderManagement()

    expect(screen.queryByRole('button', { name: 'changePlan' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'billingHistory' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'paymentMethods' }))

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/stripe/portal', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer exact-user',
          'Content-Type': 'application/json',
          'x-csrf-token': 'csrf-test',
        },
        body: JSON.stringify({
          flow: 'payment_method_update',
          scope: 'membership',
        }),
      })
    )
    expect(JSON.stringify((global.fetch as jest.Mock).mock.calls[0])).not.toContain(
      'subscription_update'
    )
  })

  it('sends the confirmed cancellation as an exact membership deep link', async () => {
    renderManagement()

    fireEvent.click(screen.getByRole('button', { name: 'cancelSubscription' }))
    expect(screen.getByText('cancelSubscriptionConfirm')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'confirmCancel' }))

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const request = (global.fetch as jest.Mock).mock.calls[0][1]
    expect(JSON.parse(request.body)).toEqual({
      flow: 'subscription_cancel',
      scope: 'membership',
    })
  })

  it('prevents duplicate portal sessions while an action is in flight', async () => {
    let resolveRequest!: (value: { ok: boolean; json: () => Promise<unknown> }) => void
    const pending = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveRequest = resolve
    })
    global.fetch = jest.fn(() => pending) as jest.Mock
    renderManagement()

    const paymentButton = screen.getByRole('button', { name: 'paymentMethods' })
    fireEvent.click(paymentButton)
    fireEvent.click(paymentButton)

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    expect(paymentButton).toBeDisabled()

    resolveRequest({
      ok: false,
      json: async () => ({ error: 'unavailable' }),
    })
    await waitFor(() => expect(paymentButton).toBeEnabled())
  })
})
