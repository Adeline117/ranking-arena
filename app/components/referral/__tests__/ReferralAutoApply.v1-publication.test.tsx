import { render } from '@testing-library/react'

const mockGetSession = jest.fn()
const mockOnAuthStateChange = jest.fn()
const mockAuthedFetch = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      onAuthStateChange: (...args: unknown[]) => mockOnAuthStateChange(...args),
    },
  },
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { PENDING_REF_KEY } from '@/lib/referral/pending'
import { V1_REFERRAL_PROGRAM_PUBLISHED } from '@/lib/referral/v1-publication'
import ReferralAutoApply from '../ReferralAutoApply'

describe('ReferralAutoApply V1 publication hold', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.localStorage.clear()
    window.localStorage.setItem(
      PENDING_REF_KEY,
      JSON.stringify({ code: 'friend_1', ts: Date.now() })
    )
  })

  it('does not subscribe, inspect pending storage, or POST while publication is false', () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem')
    const stored = window.localStorage.getItem(PENDING_REF_KEY)
    getItem.mockClear()

    render(<ReferralAutoApply />)

    expect(V1_REFERRAL_PROGRAM_PUBLISHED).toBe(false)
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockOnAuthStateChange).not.toHaveBeenCalled()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(PENDING_REF_KEY)).toBe(stored)

    getItem.mockRestore()
  })
})
