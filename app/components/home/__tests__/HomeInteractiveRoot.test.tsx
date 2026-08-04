import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import HomeInteractiveRoot from '../HomeInteractiveRoot'

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function DeferredPhaseTwoExtra() {
      return <div data-testid="deferred-phase-two-extra" />
    },
}))

jest.mock('../../Providers', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => (
    <section data-testid="homepage-providers">{children}</section>
  ),
}))

jest.mock('../WelcomeBanner', () => ({
  __esModule: true,
  default: () => <div data-testid="welcome-banner" />,
}))

jest.mock('../../presence/PresenceHeartbeat', () => ({
  __esModule: true,
  default: () => <div data-testid="presence-heartbeat" />,
}))

jest.mock('../HomePage', () => ({
  __esModule: true,
  default: ({
    initialIsStale,
    initialTotalCount,
  }: {
    initialIsStale?: boolean
    initialTotalCount?: number
  }) => (
    <div
      data-testid="interactive-homepage"
      data-initial-is-stale={String(initialIsStale)}
      data-initial-total-count={String(initialTotalCount)}
    />
  ),
}))

describe('HomeInteractiveRoot', () => {
  it('owns the provider-wrapped homepage graph and forwards SSR data', () => {
    render(<HomeInteractiveRoot initialIsStale initialTotalCount={321} />)

    const providers = screen.getByTestId('homepage-providers')
    const interactiveHome = within(providers).getByTestId('interactive-homepage')

    expect(within(providers).getByTestId('welcome-banner')).toBeInTheDocument()
    expect(within(providers).getByTestId('presence-heartbeat')).toBeInTheDocument()
    expect(interactiveHome).toHaveAttribute('data-initial-is-stale', 'true')
    expect(interactiveHome).toHaveAttribute('data-initial-total-count', '321')
    expect(within(providers).getAllByTestId('deferred-phase-two-extra')).toHaveLength(3)
  })
})
