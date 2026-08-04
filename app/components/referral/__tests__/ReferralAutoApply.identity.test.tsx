import { StrictMode } from 'react'
import { act, render, waitFor } from '@testing-library/react'

const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '44444444-4444-4444-8444-444444444444'
const REFERRER_ID = '22222222-2222-4222-8222-222222222222'
const ATTRIBUTION_ID = '33333333-3333-4333-8333-333333333333'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'pending' | 'anon' | `user:${string}`
}

function signedIn(userId: string, generation: number): MockAuth {
  return {
    accessToken: `token-${userId}-${generation}`,
    authChecked: true,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth = signedIn(VIEWER_A, 1)
const mockAuthedFetch = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))
jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import ReferralAutoApply from '../ReferralAutoApply'
import {
  capturePendingReferral,
  peekPendingReferral,
  PENDING_REF_KEY,
} from '@/lib/referral/pending'

function successAcknowledgement(
  viewerId = VIEWER_A,
  code = 'alice-code',
  extra: Record<string, unknown> = {}
) {
  return {
    success: true,
    status: 'applied',
    referred_id: viewerId,
    referrer_id: REFERRER_ID,
    attribution_id: ATTRIBUTION_ID,
    created: true,
    code,
    referrer_handle: 'alice',
    ...extra,
  }
}

function result(status: number, data: unknown) {
  return { ok: status >= 200 && status < 300, status, data }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('ReferralAutoApply identity-bound pending attribution', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.localStorage.clear()
    mockAuth = signedIn(VIEWER_A, 1)
  })

  it('consumes only an exact 200 acknowledgement for the canonical viewer and code', async () => {
    capturePendingReferral('?ref=alice-code')
    mockAuthedFetch.mockResolvedValue(result(200, successAcknowledgement()))

    render(<ReferralAutoApply />)

    await waitFor(() => expect(peekPendingReferral()).toBeNull())
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/referral/apply',
      'POST',
      mockAuth.accessToken,
      { code: 'alice-code' },
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('puts only one request on the wire across a same-frame Strict Mode remount', async () => {
    capturePendingReferral('?ref=alice-code')
    mockAuthedFetch.mockResolvedValue(result(200, successAcknowledgement()))

    render(
      <StrictMode>
        <ReferralAutoApply />
      </StrictMode>
    )

    await waitFor(() => expect(peekPendingReferral()).toBeNull())
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
  })

  it('drops a late old-viewer receipt without consuming the pending code', async () => {
    capturePendingReferral('?ref=alice-code')
    const oldRequest = deferred<ReturnType<typeof result>>()
    mockAuthedFetch
      .mockImplementationOnce(() => oldRequest.promise)
      .mockResolvedValueOnce(
        result(503, {
          success: false,
          code: 'REFERRAL_AUTHORITY_UNAVAILABLE',
          error: 'Failed to apply referral code',
        })
      )
    const view = render(<ReferralAutoApply />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    mockAuth = signedIn(VIEWER_B, 2)
    view.rerender(<ReferralAutoApply />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))

    await act(async () => {
      oldRequest.resolve(result(200, successAcknowledgement(VIEWER_A)))
      await oldRequest.promise
      await Promise.resolve()
    })

    expect(peekPendingReferral()).toBe('alice-code')
  })

  it('never lets an old response delete a newer captured code', async () => {
    capturePendingReferral('?ref=old-code')
    const oldRequest = deferred<ReturnType<typeof result>>()
    mockAuthedFetch.mockImplementationOnce(() => oldRequest.promise)
    render(<ReferralAutoApply />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    window.localStorage.setItem(
      PENDING_REF_KEY,
      JSON.stringify({ code: 'new-code', ts: Date.now() })
    )
    await act(async () => {
      oldRequest.resolve(result(200, successAcknowledgement(VIEWER_A, 'old-code')))
      await oldRequest.promise
      await Promise.resolve()
    })

    expect(peekPendingReferral()).toBe('new-code')
  })

  it.each([
    [
      'a 500',
      result(500, {
        success: false,
        code: 'REFERRAL_AUTHORITY_UNAVAILABLE',
        error: 'Failed to apply referral code',
      }),
    ],
    ['a 429', result(429, { success: false, code: 'RATE_LIMITED', error: 'Rate limited' })],
    ['a malformed 200', result(200, { success: true })],
    [
      'an expanded 200',
      result(200, successAcknowledgement(VIEWER_A, 'alice-code', { unexpected: true })),
    ],
  ])('retains the pending code after %s response', async (_label, response) => {
    capturePendingReferral('?ref=alice-code')
    mockAuthedFetch.mockResolvedValue(response)

    const view = render(<ReferralAutoApply />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    await act(async () => {
      await Promise.resolve()
    })

    expect(peekPendingReferral()).toBe('alice-code')
    view.unmount()
  })

  it('consumes an exact allowlisted permanent error', async () => {
    capturePendingReferral('?ref=missing-code')
    mockAuthedFetch.mockResolvedValue(
      result(404, {
        success: false,
        code: 'REFERRAL_CODE_NOT_FOUND',
        error: 'Referral code not found',
      })
    )

    render(<ReferralAutoApply />)

    await waitFor(() => expect(peekPendingReferral()).toBeNull())
  })

  it('retains an expanded or status-mismatched permanent error body', async () => {
    capturePendingReferral('?ref=missing-code')
    mockAuthedFetch.mockResolvedValue(
      result(429, {
        success: false,
        code: 'REFERRAL_CODE_NOT_FOUND',
        error: 'Referral code not found',
        unexpected: true,
      })
    )

    const view = render(<ReferralAutoApply />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    expect(peekPendingReferral()).toBe('missing-code')
    view.unmount()
  })
})
