import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Map()
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    method: string
    headers: Map<string, string>
    private readonly body: unknown

    constructor(
      url: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
    ) {
      this.url = url
      this.nextUrl = new URL(url)
      this.method = init.method ?? 'POST'
      this.body = init.body
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }

    async json() {
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockUser = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'two-factor@example.com',
}
const mockRpc = jest.fn()
const mockSupabase = { rpc: mockRpc }
const mockHasActiveTwoFactorProfile = jest.fn()

jest.mock('@/lib/security/two-factor-active-profile', () => ({
  hasActiveTwoFactorProfile: (...args: unknown[]) => mockHasActiveTwoFactorProfile(...args),
}))

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: Function) =>
    async (request: unknown): Promise<unknown> =>
      handler({
        user: mockUser,
        supabase: mockSupabase,
        request,
        version: { current: 'v1' },
      }),
}))

const backupCodes = [
  '0001-0001',
  '0002-0002',
  '0003-0003',
  '0004-0004',
  '0005-0005',
  '0006-0006',
  '0007-0007',
  '0008-0008',
]
const codeHashes = backupCodes.map((_, index) => `${index + 1}`.repeat(64))
const mockVerifyTotpCode = jest.fn()

jest.mock('@/lib/services/totp', () => ({
  generateBackupCodes: jest.fn(() => backupCodes),
  hashBackupCode: jest.fn((code: string) => codeHashes[backupCodes.indexOf(code)]),
  verifyTotpCode: (...args: unknown[]) => mockVerifyTotpCode(...args),
}))

const mockSignInWithPassword = jest.fn()
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: { signInWithPassword: mockSignInWithPassword },
  })),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}))

import { NextRequest } from 'next/server'
import { POST as rotateBackupCodes } from '../backup-codes/route'
import { POST as disableTwoFactor } from '../disable/route'
import { POST as verifyTwoFactor } from '../verify/route'

function request(body?: unknown) {
  return new NextRequest('http://localhost/api/settings/2fa/test', {
    method: 'POST',
    body,
  })
}

describe('atomic 2FA runtime routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHasActiveTwoFactorProfile.mockResolvedValue(true)
    mockVerifyTotpCode.mockReturnValue(true)
    mockSignInWithPassword.mockResolvedValue({
      data: { user: mockUser, session: { user: mockUser } },
      error: null,
    })
  })

  it('rotates backup codes through one exact atomic RPC', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'rotated', code_count: 8 }, error: null })

    const response = await rotateBackupCodes(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, backupCodes })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('rotate_two_factor_backup_codes_atomic', {
      p_user_id: mockUser.id,
      p_code_hashes: codeHashes,
    })
    expect(mockHasActiveTwoFactorProfile).toHaveBeenCalledWith(mockUser)
  })

  it.each([
    ['zero rows', { data: null, error: null }],
    ['extra fields', { data: { status: 'rotated', code_count: 8, warning: true }, error: null }],
    ['wrong cardinality', { data: { status: 'rotated', code_count: 7 }, error: null }],
    ['database error', { data: null, error: { message: 'insert failed' } }],
  ])('fails backup rotation closed on %s', async (_label, result) => {
    mockRpc.mockResolvedValue(result)

    const response = await rotateBackupCodes(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.backupCodes).toBeUndefined()
  })

  it('returns a non-success response when backup rotation sees disabled state', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'not_enabled' }, error: null })

    const response = await rotateBackupCodes(request())
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.backupCodes).toBeUndefined()
  })

  it('never releases rotated backup codes after a lifecycle suspension', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'suspended' }, error: null })

    const response = await rotateBackupCodes(request())
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.backupCodes).toBeUndefined()
    expect(mockHasActiveTwoFactorProfile).not.toHaveBeenCalled()
  })

  it('withholds rotated backup codes when pre-release admission loses', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'rotated', code_count: 8 }, error: null })
    mockHasActiveTwoFactorProfile.mockResolvedValue(false)

    const response = await rotateBackupCodes(request())
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.backupCodes).toBeUndefined()
  })

  it('binds enablement to the exact secret that passed TOTP verification', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: { status: 'ready', totp_secret: 'JBSWY3DPEHPK3PXP' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: 'enabled', code_count: 8 },
        error: null,
      })

    const response = await verifyTwoFactor(request({ code: '123456' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, backupCodes })
    expect(mockVerifyTotpCode).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP', '123456')
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'enable_two_factor_credentials_atomic', {
      p_user_id: mockUser.id,
      p_expected_totp_secret: 'JBSWY3DPEHPK3PXP',
      p_code_hashes: codeHashes,
    })
  })

  it('does not mutate credentials after an invalid TOTP code', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { status: 'ready', totp_secret: 'JBSWY3DPEHPK3PXP' },
      error: null,
    })
    mockVerifyTotpCode.mockReturnValue(false)

    const response = await verifyTwoFactor(request({ code: '123456' }))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.backupCodes).toBeUndefined()
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('fails verification closed when the enrollment read returns zero rows', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null })

    const response = await verifyTwoFactor(request({ code: '123456' }))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.backupCodes).toBeUndefined()
    expect(mockVerifyTotpCode).not.toHaveBeenCalled()
  })

  it('returns conflict and no codes when setup changes during verification', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: { status: 'ready', totp_secret: 'JBSWY3DPEHPK3PXP' },
        error: null,
      })
      .mockResolvedValueOnce({ data: { status: 'secret_changed' }, error: null })

    const response = await verifyTwoFactor(request({ code: '123456' }))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.backupCodes).toBeUndefined()
  })

  it('rejects suspension during enrollment read before TOTP verification', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'suspended' }, error: null })

    const response = await verifyTwoFactor(request({ code: '123456' }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.backupCodes).toBeUndefined()
    expect(mockVerifyTotpCode).not.toHaveBeenCalled()
  })

  it('rejects suspension during enablement without releasing generated codes', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: { status: 'ready', totp_secret: 'JBSWY3DPEHPK3PXP' },
        error: null,
      })
      .mockResolvedValueOnce({ data: { status: 'suspended' }, error: null })

    const response = await verifyTwoFactor(request({ code: '123456' }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.backupCodes).toBeUndefined()
    expect(mockHasActiveTwoFactorProfile).not.toHaveBeenCalled()
  })

  it('withholds enabled backup codes when pre-release admission loses', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: { status: 'ready', totp_secret: 'JBSWY3DPEHPK3PXP' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: 'enabled', code_count: 8 },
        error: null,
      })
    mockHasActiveTwoFactorProfile.mockResolvedValue(false)

    const response = await verifyTwoFactor(request({ code: '123456' }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.backupCodes).toBeUndefined()
  })

  it.each([
    ['zero rows', { data: null, error: null }],
    [
      'malformed success',
      { data: { status: 'enabled', code_count: 8, warning: 'partial' }, error: null },
    ],
    ['database error', { data: null, error: { message: 'enable failed' } }],
  ])('never reports verification success after enablement %s', async (_label, result) => {
    mockRpc
      .mockResolvedValueOnce({
        data: { status: 'ready', totp_secret: 'JBSWY3DPEHPK3PXP' },
        error: null,
      })
      .mockResolvedValueOnce(result)

    const response = await verifyTwoFactor(request({ code: '123456' }))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.success).not.toBe(true)
    expect(body.backupCodes).toBeUndefined()
  })

  it('disables the flag, secret, and codes through one exact RPC after password proof', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'disabled', code_count: 8, secret_count: 1 },
      error: null,
    })

    const response = await disableTwoFactor(request({ password: 'correct horse' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('disable_two_factor_credentials_atomic', {
      p_user_id: mockUser.id,
    })
  })

  it('never reaches disablement authority when password proof fails', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'invalid password' },
    })

    const response = await disableTwoFactor(request({ password: 'wrong' }))

    expect(response.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects suspended disablement and preserves the failure boundary', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'suspended' }, error: null })

    const response = await disableTwoFactor(request({ password: 'correct horse' }))

    expect(response.status).toBe(403)
    expect(mockHasActiveTwoFactorProfile).not.toHaveBeenCalled()
  })

  it('does not report disablement success when pre-release admission loses', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'disabled', code_count: 8, secret_count: 1 },
      error: null,
    })
    mockHasActiveTwoFactorProfile.mockResolvedValue(false)

    const response = await disableTwoFactor(request({ password: 'correct horse' }))

    expect(response.status).toBe(403)
  })

  it.each([
    ['user', { user: { ...mockUser, id: 'other-user' }, session: { user: mockUser } }],
    ['session', { user: mockUser, session: { user: { ...mockUser, id: 'other-user' } } }],
    ['missing session', { user: mockUser, session: null }],
  ])('never disables 2FA when the password proof belongs to another %s', async (_label, data) => {
    mockSignInWithPassword.mockResolvedValue({ data, error: null })

    const response = await disableTwoFactor(request({ password: 'correct horse' }))

    expect(response.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects oversized password input before invoking authentication', async () => {
    const response = await disableTwoFactor(request({ password: 'x'.repeat(4097) }))

    expect(response.status).toBe(400)
    expect(mockSignInWithPassword).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['zero rows', { data: null, error: null }],
    [
      'extra fields',
      {
        data: { status: 'disabled', code_count: 8, secret_count: 1, partial: true },
        error: null,
      },
    ],
    ['database error', { data: null, error: { message: 'delete failed' } }],
  ])('never reports disablement success after %s', async (_label, result) => {
    mockRpc.mockResolvedValue(result)

    const response = await disableTwoFactor(request({ password: 'correct horse' }))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.success).not.toBe(true)
  })

  it('contains no direct 2FA credential mutations in any runtime route', () => {
    for (const route of ['setup', 'verify', 'backup-codes', 'disable']) {
      const source = readFileSync(
        resolve(process.cwd(), `app/api/settings/2fa/${route}/route.ts`),
        'utf8'
      )
      expect(source).not.toMatch(/\.from\(['"](?:backup_codes|user_2fa_secrets)['"]\)/)
      expect(source).not.toMatch(
        /\.from\(['"]user_profiles['"]\)[\s\S]{0,160}\.update\(\{\s*totp_enabled:/
      )
    }
  })
})
