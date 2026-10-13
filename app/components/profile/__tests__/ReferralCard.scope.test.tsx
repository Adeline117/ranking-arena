import { render, screen } from '@testing-library/react'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/lib/api/client', () => ({ authedFetch: jest.fn() }))

import { authedFetch } from '@/lib/api/client'
import { V1_REFERRAL_PROGRAM_PUBLISHED } from '@/lib/referral/v1-publication'
import ReferralCard from '../ReferralCard'

describe('ReferralCard V1 publication hold', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows only the unavailable status and never requests or exposes a referral action', () => {
    expect(V1_REFERRAL_PROGRAM_PUBLISHED).toBe(false)

    render(<ReferralCard />)

    expect(screen.getByRole('status')).toHaveTextContent('referralUnavailableTitle')
    expect(screen.getByRole('status')).toHaveTextContent('referralUnavailableDescription')
    expect(screen.getByRole('status')).toHaveTextContent('referralUnavailableHistoryNote')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(authedFetch).not.toHaveBeenCalled()
  })
})
