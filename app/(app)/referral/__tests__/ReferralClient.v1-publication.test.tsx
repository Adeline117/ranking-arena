import { render, screen } from '@testing-library/react'

const mockFetch = jest.fn()

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/layout/FloatingActionButton', () => () => null)

import { V1_REFERRAL_PROGRAM_PUBLISHED } from '@/lib/referral/v1-publication'
import ReferralClient from '../ReferralClient'

describe('ReferralClient V1 publication hold', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    mockFetch.mockReset()
    global.fetch = mockFetch as typeof fetch
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('renders a status-only route without referral-link or reward controls', () => {
    expect(V1_REFERRAL_PROGRAM_PUBLISHED).toBe(false)

    render(<ReferralClient />)

    expect(screen.getByRole('heading', { name: 'referralUnavailableTitle' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('referralUnavailableHistoryNote')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
