import { render, screen } from '@testing-library/react'

const mockAuthedFetch = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    accessToken: 'unused-while-unpublished',
    authChecked: true,
    email: 'user-1@example.com',
    loading: false,
    sessionGeneration: 1,
    userId: 'user-1',
    viewerKey: 'user:user-1',
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        {
          traderAlertsUnavailableDesc: 'Saved alerts are not being monitored during V1.',
          traderAlertsUnavailableTitle: 'Trader alerts are unavailable',
        } as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: ({ title, description }: { title: string; description?: string }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
    </section>
  ),
}))

jest.mock('../AlertRowComponents', () => ({ AlertRow: () => null }))
jest.mock('../AlertHistory', () => ({ AlertHistory: () => null }))

import AlertConfig from '../AlertConfig'
import { TRADER_ALERTS_PUBLISHED } from '@/lib/alerts/trader-alert-publication'

describe('AlertConfig V1 publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows unavailable without loading or exposing configuration controls by default', () => {
    expect(TRADER_ALERTS_PUBLISHED).toBe(false)

    render(<AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />)

    expect(screen.getByRole('heading', { name: 'Trader alerts are unavailable' })).toBeVisible()
    expect(screen.getByText('Saved alerts are not being monitored during V1.')).toBeVisible()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })
})
