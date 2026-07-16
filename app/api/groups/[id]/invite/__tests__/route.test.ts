import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()

    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockLogError = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        request: { url: string; json: () => Promise<unknown> }
      }) => unknown
    ) =>
    async (request: { url: string; json: () => Promise<unknown> }) =>
      handler({
        user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        request,
      }),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}))
jest.mock('@/lib/types/premium', () => ({ PRO_FREE_PROMO: true }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLogError(...args) }),
}))

import { DELETE, GET, POST } from '../route'
import { generateInviteToken, hashInviteToken, verifyInviteToken } from '@/lib/groups/invite-tokens'

const GROUP_ID = '10000000-0000-4000-8000-000000000001'
const INVITE_ID = '40000000-0000-4000-8000-000000000004'

function request(method: 'GET' | 'POST' | 'DELETE', suffix = '', body: unknown = null) {
  return {
    method,
    url: `http://localhost/api/groups/${GROUP_ID}/invite${suffix}`,
    json: jest.fn().mockResolvedValue(body),
  }
}

describe('atomic group invite route', () => {
  beforeAll(() => {
    process.env.INVITE_SECRET = 'route-test-invite-secret-with-more-than-thirty-two-characters'
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('inspects a signed invite without mutating its capacity', async () => {
    const token = generateInviteToken(GROUP_ID, Date.now() + 60_000)
    mockRpc.mockResolvedValue({ data: { status: 'valid' }, error: null })

    const response = await GET(request('GET', `?verify=${encodeURIComponent(token)}`) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, valid: true })
    expect(mockRpc).toHaveBeenCalledWith('inspect_group_invite_atomic', {
      p_actor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      p_group_id: GROUP_ID,
      p_token_hash: hashInviteToken(token),
      p_pro_free_promo: true,
    })
  })

  it('rejects an invalid signature before any database call', async () => {
    const response = await GET(request('GET', '?verify=not-a-signed-token') as never)

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when inspection fails or returns an unknown status', async () => {
    const token = generateInviteToken(GROUP_ID, Date.now() + 60_000)
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
      .mockResolvedValueOnce({ data: { status: 'future_status' }, error: null })

    const failed = await GET(request('GET', `?verify=${token}`) as never)
    const unknown = await GET(request('GET', `?verify=${token}`) as never)

    expect(failed.status).toBe(500)
    expect(unknown.status).toBe(500)
    expect(mockLogError).toHaveBeenCalled()
  })

  it('creates a nonce-bearing invite through the atomic RPC', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'created', invite_id: INVITE_ID }, error: null })

    const response = await POST(request('POST') as never)
    const body = await response.json()
    const token = new URL(body.invite_url, 'http://localhost').searchParams.get('invite')

    expect(response.status).toBe(200)
    expect(token).not.toBeNull()
    expect(verifyInviteToken(token as string).valid).toBe(true)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith(
      'create_group_invite_atomic',
      expect.objectContaining({
        p_actor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        p_group_id: GROUP_ID,
        p_token_hash: hashInviteToken(token as string),
        p_max_uses: 50,
      })
    )
  })

  it('retries a token collision with a different hash', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'token_conflict' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'created', invite_id: INVITE_ID }, error: null })

    const response = await POST(request('POST') as never)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRpc.mock.calls[0][1].p_token_hash).not.toBe(mockRpc.mock.calls[1][1].p_token_hash)
  })

  it('maps database-owned creation limits without direct table fallbacks', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'rate_limited' }, error: null })

    const response = await POST(request('POST') as never)

    expect(response.status).toBe(429)
    const source = readFileSync(join(process.cwd(), 'app/api/groups/[id]/invite/route.ts'), 'utf8')
    expect(source).not.toContain(".from('group_invites')")
    expect(source).not.toContain('.insert(')
    expect(source).not.toContain('.update(')
  })

  it('soft-revokes idempotently through the atomic RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'revoked' }, error: null })

    const revoked = await DELETE(request('DELETE', '', { invite_id: INVITE_ID }) as never)
    expect(revoked.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('revoke_group_invite_atomic', {
      p_actor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      p_group_id: GROUP_ID,
      p_invite_id: INVITE_ID,
    })

    mockRpc.mockResolvedValueOnce({ data: { status: 'already_revoked' }, error: null })
    const repeated = await DELETE(request('DELETE', '', { invite_id: INVITE_ID }) as never)
    await expect(repeated.json()).resolves.toEqual({ success: true, already_revoked: true })
  })

  it('rejects malformed group and invite IDs before calling the RPC', async () => {
    const badGroupRequest = {
      ...request('POST'),
      url: 'http://localhost/api/groups/not-a-uuid/invite',
    }
    const badInviteRequest = request('DELETE', '', { invite_id: 'not-a-uuid' })

    expect((await POST(badGroupRequest as never)).status).toBe(400)
    expect((await DELETE(badInviteRequest as never)).status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
