/** @jest-environment node */

const mockSendEmail = jest.fn()
const mockExtractUser = jest.fn()
const mockIncr = jest.fn()

jest.mock('@/lib/services/email', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}))
jest.mock('@/lib/auth/extract-user', () => ({
  extractUserFromRequest: (...args: unknown[]) => mockExtractUser(...args),
}))
jest.mock('@/lib/cache', () => ({ incr: (...args: unknown[]) => mockIncr(...args) }))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { authenticated: {} },
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const userCreated = (minutes: number) =>
  mockExtractUser.mockResolvedValue({
    user: { id: 'user-1', email: 'new@example.com', created_at: minutesAgo(minutes) },
    error: null,
  })
const post = async () =>
  (await POST(new NextRequest('http://localhost/api/email/welcome', { method: 'POST' }))).json()

describe('POST /api/email/welcome', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendEmail.mockResolvedValue(true)
    mockIncr.mockResolvedValue(1)
  })

  it('sends to an email signup that took ten minutes to finish onboarding', async () => {
    userCreated(10)

    await expect(post()).resolves.toEqual({ ok: true, sent: true })
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockIncr).toHaveBeenCalledWith('welcome-email-sent:user-1')
  })

  it('never sends twice to the same user', async () => {
    userCreated(1)
    mockIncr.mockResolvedValue(2)

    await expect(post()).resolves.toEqual({ ok: true, skipped: 'already_sent' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does not treat an old account as new', async () => {
    userCreated(60 * 48)

    await expect(post()).resolves.toEqual({ ok: true, skipped: 'not_new_user' })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockIncr).not.toHaveBeenCalled()
  })

  it('falls back to the strict window when the marker store is unavailable', async () => {
    mockIncr.mockResolvedValue(null)
    userCreated(10)
    await expect(post()).resolves.toEqual({ ok: true, skipped: 'not_new_user' })

    userCreated(1)
    await expect(post()).resolves.toEqual({ ok: true, sent: true })
  })
})
