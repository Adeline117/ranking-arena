/**
 * ProGate — unified Pro paywall component.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import ProGate from '../ProGate'

const mockPush = jest.fn()
const mockRefresh = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

const subscriptionState: {
  isPro: boolean
  isLoading: boolean
  error: string | null
  refresh: () => void
} = { isPro: false, isLoading: false, error: null, refresh: mockRefresh }
jest.mock('../../home/hooks/useSubscription', () => ({
  useSubscription: () => subscriptionState,
}))

describe('ProGate', () => {
  beforeEach(() => {
    subscriptionState.isPro = false
    subscriptionState.isLoading = false
    subscriptionState.error = null
    mockPush.mockClear()
    mockRefresh.mockClear()
  })

  it('renders children ungated for Pro users', () => {
    subscriptionState.isPro = true
    render(
      <ProGate variant="inline">
        <div>secret content</div>
      </ProGate>
    )
    expect(screen.getByText('secret content')).toBeInTheDocument()
    expect(screen.queryByText('startFreeTrial')).not.toBeInTheDocument()
  })

  it('renders children ungated while subscription is loading (no paywall flash)', () => {
    subscriptionState.isLoading = true
    render(
      <ProGate variant="blur">
        <div>secret content</div>
      </ProGate>
    )
    expect(screen.getByText('secret content')).toBeInTheDocument()
    expect(screen.queryByText('startFreeTrial')).not.toBeInTheDocument()
  })

  it('inline variant replaces children with the upsell card', () => {
    render(
      <ProGate variant="inline" featureKey="proFeatureBlurred">
        <div>secret content</div>
      </ProGate>
    )
    expect(screen.queryByText('secret content')).not.toBeInTheDocument()
    expect(screen.getByText('proFeatureBlurred')).toBeInTheDocument()
    fireEvent.click(screen.getByText('startFreeTrial'))
    expect(mockPush).toHaveBeenCalledWith('/pricing')
  })

  it('shows a retry state instead of a false upsell when authority is unavailable', () => {
    subscriptionState.error = 'unavailable'
    render(
      <ProGate variant="inline">
        <div>secret content</div>
      </ProGate>
    )

    expect(screen.queryByText('secret content')).not.toBeInTheDocument()
    expect(screen.queryByText('startFreeTrial')).not.toBeInTheDocument()
    expect(screen.getByText('loadFailed')).toBeInTheDocument()
    fireEvent.click(screen.getByText('retry'))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('blur variant keeps children visible (blurred) with overlaid upsell', () => {
    render(
      <ProGate variant="blur">
        <div>secret content</div>
      </ProGate>
    )
    expect(screen.getByText('secret content')).toBeInTheDocument()
    expect(screen.getByText('startFreeTrial')).toBeInTheDocument()
  })

  it('modal variant intercepts clicks and opens the upsell dialog', () => {
    render(
      <ProGate variant="modal">
        <button>locked action</button>
      </ProGate>
    )
    expect(screen.queryByText('startFreeTrial')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('locked action'))
    expect(screen.getByText('startFreeTrial')).toBeInTheDocument()
    fireEvent.click(screen.getByText('startFreeTrial'))
    expect(mockPush).toHaveBeenCalledWith('/pricing')
  })
})
