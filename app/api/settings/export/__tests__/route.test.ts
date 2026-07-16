jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }
    async json() {
      return typeof this._body === 'string' ? JSON.parse(this._body) : this._body
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockGetProvisioningAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockValidateCsrfToken = jest.fn()
const mockFetchAllExportRows = jest.fn()
const mockFetchAllExportRowsByCursor = jest.fn()
const mockFrom = jest.fn()
let profileStates: QueryState[]

jest.mock('@/lib/supabase/server', () => ({
  getProvisioningAuthUser: (...args: unknown[]) => mockGetProvisioningAuthUser(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: { name: 'write-test-policy' } },
}))

jest.mock('@/lib/utils/csrf', () => ({
  CSRF_COOKIE_NAME: 'csrf-cookie',
  CSRF_HEADER_NAME: 'x-csrf-token',
  validateCsrfToken: (...args: unknown[]) => mockValidateCsrfToken(...args),
}))

jest.mock('@/lib/account/data-export', () => {
  const actual = jest.requireActual('@/lib/account/data-export')
  return {
    ...actual,
    fetchAllExportRows: (...args: unknown[]) => mockFetchAllExportRows(...args),
    fetchAllExportRowsByCursor: (...args: unknown[]) => mockFetchAllExportRowsByCursor(...args),
  }
})

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextResponse } from 'next/server'
import { DataExportReadError, DataExportTooLargeError } from '@/lib/account/data-export'
import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PROFILE = {
  id: USER_ID,
  handle: 'viewer',
  avatar_url: null,
  bio: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: null,
  last_export_at: null,
}
type ProfileFixture = Omit<typeof PROFILE, 'last_export_at'> & { last_export_at: unknown }

type QueryState = { operation: 'read' | 'update'; selection: string | null }

function request() {
  return {
    cookies: { get: () => ({ value: 'csrf-value' }) },
    headers: { get: () => 'csrf-value' },
  } as never
}

function installProfileQueries(options: {
  profile?: ProfileFixture | null
  profileError?: unknown
  claim?: 'success' | 'lost' | 'error'
  currentLastExportAt?: string | null
}) {
  const claimMode = options.claim ?? 'success'
  const states: QueryState[] = []
  mockFrom.mockImplementation((table: string) => {
    expect(table).toBe('user_profiles')
    const state: QueryState = { operation: 'read', selection: null }
    states.push(state)
    const query = {
      select: jest.fn((selection: string) => {
        state.selection = selection
        return query
      }),
      update: jest.fn(() => {
        state.operation = 'update'
        return query
      }),
      eq: jest.fn(() => query),
      or: jest.fn(() => query),
      maybeSingle: jest.fn(async () => {
        if (state.operation === 'update') {
          if (claimMode === 'error') {
            return { data: null, error: { code: 'XX002', message: 'claim failed' } }
          }
          return {
            data: claimMode === 'success' ? { id: USER_ID } : null,
            error: null,
          }
        }
        if (state.selection === 'last_export_at') {
          return {
            data: { last_export_at: options.currentLastExportAt ?? new Date().toISOString() },
            error: null,
          }
        }
        const sourceProfile = options.profile === undefined ? PROFILE : options.profile
        if (sourceProfile === null) {
          return { data: null, error: options.profileError ?? null }
        }
        const selectedProfile = Object.fromEntries(
          (state.selection ?? '')
            .split(',')
            .filter(Boolean)
            .map((column) => [
              column,
              Object.hasOwn(sourceProfile, column)
                ? sourceProfile[column as keyof typeof sourceProfile]
                : null,
            ])
        )
        return {
          data: {
            ...selectedProfile,
            totp_secret: 'totp-must-never-escape',
            stripe_customer_id: 'cus_must_never_escape',
            banned_by: 'moderator-must-never-escape',
            role: 'internal-role-must-never-escape',
            weight: 999,
          },
          error: options.profileError ?? null,
        }
      }),
    }
    return query
  })
  return states
}

describe('POST /api/settings/export', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetProvisioningAuthUser.mockResolvedValue({ id: USER_ID })
    mockValidateCsrfToken.mockReturnValue(true)
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockFetchAllExportRows.mockImplementation(async (_client, dataset) => {
      const id = `${dataset.name}-1`
      switch (dataset.name) {
        case 'following':
          return [{ id, following_id: 'followed-user', created_at: '2026-02-01T00:00:00.000Z' }]
        case 'followers':
          return [{ id, follower_id: 'follower-user', created_at: '2026-02-02T00:00:00.000Z' }]
        case 'tips.sent':
          return [
            {
              id,
              to_user_id: 'tip-recipient',
              post_id: 'post-1',
              amount_cents: 500,
              message: 'sent tip',
              status: 'completed',
              created_at: '2026-02-03T00:00:00.000Z',
              updated_at: '2026-02-03T00:01:00.000Z',
              completed_at: '2026-02-03T00:01:00.000Z',
            },
          ]
        case 'tips.received':
          return [
            {
              id,
              from_user_id: 'tip-sender',
              post_id: null,
              amount_cents: 700,
              message: null,
              status: 'completed',
              created_at: '2026-02-04T00:00:00.000Z',
              updated_at: '2026-02-04T00:01:00.000Z',
              completed_at: '2026-02-04T00:01:00.000Z',
            },
          ]
        default:
          return [{ id }]
      }
    })
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, dataset) => {
      if (dataset.name === 'settings.preferences') {
        return [
          {
            user_id: USER_ID,
            watched_traders: ['trader-1'],
            email_notifications: true,
            push_notifications: false,
            ranking_change_threshold: 5,
            created_at: '2026-02-05T00:00:00.000Z',
            updated_at: '2026-02-06T00:00:00.000Z',
            future_secret: 'must-not-escape-normalization',
          },
        ]
      }
      if (dataset.name === 'account.bindings') {
        return [
          {
            platform: '',
            account_id: null,
            created_at: null,
            future_secret: 'must-not-escape-binding-normalization',
          },
          {
            platform: 'kraken,pro',
            account_id: 'personal-account-1',
            created_at: '2026-02-07T00:00:00.000Z',
          },
        ]
      }
      if (dataset.name === 'blocks.outgoing') {
        return [
          {
            blocked_id: '22222222-2222-4222-8222-222222222222',
            created_at: '2026-02-08T00:00:00.000Z',
            blocker_id: 'must-not-escape-block-owner',
            future_secret: 'must-not-escape-block-normalization',
          },
        ]
      }
      throw new Error(`Unexpected cursor dataset: ${dataset.name}`)
    })
    profileStates = installProfileQueries({})
  })

  it('returns only after every complete dataset is assembled and the cooldown is claimed', async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.profile).toEqual(
      expect.objectContaining({
        id: USER_ID,
        handle: 'viewer',
        avatar_url: null,
        bio: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: null,
        totp_enabled: null,
        notify_trader_events: null,
        deletion_scheduled_at: null,
      })
    )
    for (const forbiddenField of [
      'last_export_at',
      'totp_secret',
      'stripe_customer_id',
      'banned_by',
      'role',
      'weight',
    ]) {
      expect(body.profile).not.toHaveProperty(forbiddenField)
    }
    expect(JSON.stringify(body)).not.toMatch(
      /totp-must-never-escape|cus_must_never_escape|moderator-must-never-escape|internal-role-must-never-escape/
    )
    expect(body.manifest).toEqual(
      expect.objectContaining({
        schema_version: '1',
        scope: 'supported_portable_datasets',
        consistency: 'best_effort_keyset',
        completed_at: body.exportedAt,
      })
    )
    expect(Number.isNaN(Date.parse(body.manifest.started_at))).toBe(false)
    expect(Date.parse(body.manifest.completed_at)).toBeGreaterThanOrEqual(
      Date.parse(body.manifest.started_at)
    )
    expect(new Set(body.manifest.datasets.map((dataset) => dataset.name)).size).toBe(
      body.manifest.datasets.length
    )
    expect(
      Object.fromEntries(body.manifest.datasets.map((dataset) => [dataset.name, dataset.row_count]))
    ).toEqual({
      profile: 1,
      posts: 1,
      comments: 1,
      'follows.following': 1,
      'follows.followers': 1,
      'blocks.outgoing': 1,
      'tips.sent': 1,
      'tips.received': 1,
      'settings.preferences': 1,
      'account.bindings': 2,
      'account.login_sessions': 1,
      'account.api_keys': 1,
      'account.passkeys': 1,
      'account.push_subscriptions': 1,
      'account.backup_codes': 1,
      'account.recovery_tokens': 1,
    })
    expect(body.manifest.datasets.every((dataset) => dataset.status === 'complete')).toBe(true)
    expect(profileStates[0]?.selection).toContain('email')
    expect(profileStates[0]?.selection).toContain('totp_enabled')
    expect(profileStates[0]?.selection).not.toContain('totp_secret')
    expect(profileStates[0]?.selection).not.toContain('stripe_customer_id')
    expect(profileStates[0]?.selection).not.toContain('banned_by')
    expect(body.posts).toEqual([{ id: 'posts-1' }])
    expect(body.comments).toEqual([{ id: 'comments-1' }])
    expect(body.follows.following).toEqual([
      {
        id: 'following-1',
        direction: 'following',
        other_user_id: 'followed-user',
        created_at: '2026-02-01T00:00:00.000Z',
      },
    ])
    expect(body.follows.followers).toEqual([
      {
        id: 'followers-1',
        direction: 'follower',
        other_user_id: 'follower-user',
        created_at: '2026-02-02T00:00:00.000Z',
      },
    ])
    expect(body.blocks).toEqual({
      outgoing: [
        {
          blocked_user_id: '22222222-2222-4222-8222-222222222222',
          created_at: '2026-02-08T00:00:00.000Z',
        },
      ],
    })
    expect(JSON.stringify(body.blocks)).not.toMatch(
      /must-not-escape-block-owner|must-not-escape-block-normalization|blocker_id/
    )
    expect(body.tips.sent).toEqual([
      {
        id: 'tips.sent-1',
        direction: 'sent',
        counterparty_user_id: 'tip-recipient',
        post_id: 'post-1',
        amount_cents: 500,
        message: 'sent tip',
        status: 'completed',
        created_at: '2026-02-03T00:00:00.000Z',
        updated_at: '2026-02-03T00:01:00.000Z',
        completed_at: '2026-02-03T00:01:00.000Z',
      },
    ])
    expect(body.tips.received).toEqual([
      {
        id: 'tips.received-1',
        direction: 'received',
        counterparty_user_id: 'tip-sender',
        post_id: null,
        amount_cents: 700,
        message: null,
        status: 'completed',
        created_at: '2026-02-04T00:00:00.000Z',
        updated_at: '2026-02-04T00:01:00.000Z',
        completed_at: '2026-02-04T00:01:00.000Z',
      },
    ])
    expect(body.settings).toEqual({
      preferences: {
        watched_traders: ['trader-1'],
        email_notifications: true,
        push_notifications: false,
        ranking_change_threshold: 5,
        created_at: '2026-02-05T00:00:00.000Z',
        updated_at: '2026-02-06T00:00:00.000Z',
      },
    })
    expect(JSON.stringify(body.settings)).not.toContain('must-not-escape-normalization')
    expect(body.account).toEqual({
      bindings: [
        { platform: '', account_id: null, created_at: null },
        {
          platform: 'kraken,pro',
          account_id: 'personal-account-1',
          created_at: '2026-02-07T00:00:00.000Z',
        },
      ],
      login_sessions: [{ id: 'account.login_sessions-1' }],
      api_keys: [{ id: 'account.api_keys-1' }],
      passkeys: [{ id: 'account.passkeys-1' }],
      push_subscriptions: [{ id: 'account.push_subscriptions-1' }],
      backup_codes: [{ id: 'account.backup_codes-1' }],
      recovery_tokens: [{ id: 'account.recovery_tokens-1' }],
    })
    expect(JSON.stringify(body.account.bindings)).not.toContain(
      'must-not-escape-binding-normalization'
    )
    expect(mockFetchAllExportRows).toHaveBeenCalledTimes(12)
    expect(mockFetchAllExportRowsByCursor).toHaveBeenCalledTimes(3)
    expect(mockFrom).toHaveBeenCalledTimes(2)
    expect(response.headers.get('Content-Disposition')).not.toContain(USER_ID)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('Pragma')).toBe('no-cache')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')

    const datasets = mockFetchAllExportRows.mock.calls.map((call) => call[1])
    expect(datasets).toHaveLength(12)
    expect(mockFetchAllExportRows.mock.calls.every((call) => call[2] === USER_ID)).toBe(true)
    for (const dataset of datasets) {
      expect(dataset.selectColumns).toContain('id')
      expect(dataset.selectColumns).not.toContain('*')
      expect(dataset.selectColumns.join(',')).not.toMatch(
        /stripe|token|secret|password|credential|_encrypted|deleted_by/i
      )
    }
    const commentsDataset = datasets.find((dataset) => dataset.name === 'comments')
    expect(commentsDataset.selectColumns).not.toContain('author_id')
    expect(commentsDataset.selectColumns).not.toContain('author_handle')

    const apiKeysDataset = datasets.find((dataset) => dataset.name === 'account.api_keys')
    expect(apiKeysDataset.selectColumns).not.toContain('key')
    const passkeysDataset = datasets.find((dataset) => dataset.name === 'account.passkeys')
    for (const forbiddenField of ['credential_id', 'public_key', 'counter']) {
      expect(passkeysDataset.selectColumns).not.toContain(forbiddenField)
    }
    const pushDataset = datasets.find((dataset) => dataset.name === 'account.push_subscriptions')
    for (const forbiddenField of ['token', 'endpoint', 'auth', 'p256dh', 'device_id']) {
      expect(pushDataset.selectColumns).not.toContain(forbiddenField)
    }
    const backupDataset = datasets.find((dataset) => dataset.name === 'account.backup_codes')
    expect(backupDataset.selectColumns).not.toContain('code_hash')
    const recoveryDataset = datasets.find((dataset) => dataset.name === 'account.recovery_tokens')
    expect(recoveryDataset.selectColumns).not.toContain('token_hash')

    const preferencesCall = mockFetchAllExportRowsByCursor.mock.calls.find(
      (call) => call[1].name === 'settings.preferences'
    )
    expect(preferencesCall).toBeDefined()
    expect(preferencesCall[2]).toBe(USER_ID)
    expect(preferencesCall[1]).toEqual(
      expect.objectContaining({
        name: 'settings.preferences',
        table: 'user_preferences',
        ownerPredicate: { column: 'user_id', operator: 'eq', valueType: 'uuid' },
        cursor: {
          order: 'asc',
          columns: [{ column: 'user_id', valueType: 'uuid' }],
        },
      })
    )
    expect(preferencesCall[1].selectColumns).not.toContain('*')

    const bindingsCall = mockFetchAllExportRowsByCursor.mock.calls.find(
      (call) => call[1].name === 'account.bindings'
    )
    expect(bindingsCall).toBeDefined()
    expect(bindingsCall[2]).toBe(USER_ID)
    expect(bindingsCall[1]).toEqual(
      expect.objectContaining({
        name: 'account.bindings',
        table: 'account_bindings',
        selectColumns: ['platform', 'account_id', 'created_at'],
        ownerPredicate: { column: 'user_id', operator: 'eq', valueType: 'uuid' },
        cursor: {
          order: 'asc',
          columns: [{ column: 'platform', valueType: 'string' }],
        },
      })
    )
    expect(bindingsCall[1].selectColumns).not.toContain('user_id')

    const outgoingBlocksCall = mockFetchAllExportRowsByCursor.mock.calls.find(
      (call) => call[1].name === 'blocks.outgoing'
    )
    expect(outgoingBlocksCall).toBeDefined()
    expect(outgoingBlocksCall[2]).toBe(USER_ID)
    expect(outgoingBlocksCall[1]).toEqual(
      expect.objectContaining({
        name: 'blocks.outgoing',
        table: 'blocked_users',
        selectColumns: ['blocked_id', 'created_at'],
        ownerPredicate: { column: 'blocker_id', operator: 'eq', valueType: 'uuid' },
        cursor: {
          order: 'asc',
          columns: [{ column: 'blocked_id', valueType: 'uuid' }],
        },
      })
    )
    expect(outgoingBlocksCall[1].selectColumns).not.toContain('blocker_id')
  })

  it('fails closed without cooldown when preferences cannot be read completely', async () => {
    mockFetchAllExportRowsByCursor.mockRejectedValueOnce(
      new DataExportReadError('settings.preferences', { code: 'XX001' })
    )

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed without cooldown when account bindings cannot be read completely', async () => {
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, dataset) => {
      if (dataset.name === 'settings.preferences') return []
      throw new DataExportReadError('account.bindings', { code: 'XX001' })
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed without cooldown when outgoing blocks cannot be read completely', async () => {
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, dataset) => {
      if (dataset.name === 'blocks.outgoing') {
        throw new DataExportReadError('blocks.outgoing', { code: 'XX001' })
      }
      return []
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('represents an uncreated preferences row explicitly without widening the export', async () => {
    mockFetchAllExportRowsByCursor.mockResolvedValueOnce([])

    const response = await POST(request())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.settings).toEqual({ preferences: null })
    expect(
      body.manifest.datasets.find((dataset) => dataset.name === 'settings.preferences')
    ).toEqual({ name: 'settings.preferences', status: 'complete', row_count: 0 })
  })

  it('fails closed if the preferences singleton invariant is violated', async () => {
    const row = {
      user_id: USER_ID,
      watched_traders: [],
      email_notifications: true,
      push_notifications: false,
      ranking_change_threshold: 10,
      created_at: null,
      updated_at: null,
    }
    mockFetchAllExportRowsByCursor.mockResolvedValueOnce([row, row])

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
  })

  it('fails closed without consuming cooldown when one dataset page fails', async () => {
    mockFetchAllExportRows.mockRejectedValueOnce(
      new DataExportReadError('comments', { code: 'XX001' })
    )

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('returns an explicit 413 without cooldown when the full export is too large', async () => {
    mockFetchAllExportRows.mockRejectedValueOnce(new DataExportTooLargeError('posts'))

    const response = await POST(request())

    expect(response.status).toBe(413)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the provisioned profile row is missing', async () => {
    installProfileQueries({ profile: null })

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(mockFetchAllExportRows).not.toHaveBeenCalled()
    expect(mockFetchAllExportRowsByCursor).not.toHaveBeenCalled()
  })

  it('fails closed when the profile cooldown field has an invalid runtime shape', async () => {
    installProfileQueries({ profile: { ...PROFILE, last_export_at: 42 } })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFetchAllExportRows).not.toHaveBeenCalled()
    expect(mockFetchAllExportRowsByCursor).not.toHaveBeenCalled()
  })

  it('honors an existing durable cooldown before reading export datasets', async () => {
    installProfileQueries({
      profile: { ...PROFILE, last_export_at: new Date().toISOString() },
    })

    const response = await POST(request())

    expect(response.status).toBe(429)
    expect(mockFetchAllExportRows).not.toHaveBeenCalled()
    expect(mockFetchAllExportRowsByCursor).not.toHaveBeenCalled()
  })

  it('lets only the conditional-update winner return a concurrent download', async () => {
    const winnerStates = installProfileQueries({ claim: 'success' })
    const winner = await POST(request())
    expect(winner.status).toBe(200)
    expect(winnerStates.some((state) => state.operation === 'update')).toBe(true)

    const lastExportAt = new Date().toISOString()
    installProfileQueries({ claim: 'lost', currentLastExportAt: lastExportAt })
    const loser = await POST(request())

    expect(loser.status).toBe(429)
    expect((await loser.json()).error).toContain(
      new Date(new Date(lastExportAt).getTime() + 24 * 60 * 60 * 1000).toISOString()
    )
  })

  it('does not return a download when the atomic cooldown claim errors', async () => {
    installProfileQueries({ claim: 'error' })

    const response = await POST(request())

    expect(response.status).toBe(500)
  })

  it('stops before authentication/admin work when the route limiter responds', async () => {
    const limited = NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    mockCheckRateLimit.mockResolvedValue(limited)

    const response = await POST(request())

    expect(response).toBe(limited)
    expect(mockGetProvisioningAuthUser).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })
})
