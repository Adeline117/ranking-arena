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
const mockFetchAllExportRowsForUuidParents = jest.fn()
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
    fetchAllExportRowsForUuidParents: (...args: unknown[]) =>
      mockFetchAllExportRowsForUuidParents(...args),
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
      if (dataset.name === 'interactions.post_likes') {
        return [
          {
            post_id: '33333333-3333-4333-8333-333333333333',
            reaction_type: 'like',
            created_at: '2026-02-09T00:00:00.000Z',
            user_id: 'must-not-escape-like-owner',
          },
        ]
      }
      if (dataset.name === 'interactions.post_votes') {
        return [
          {
            post_id: '44444444-4444-4444-8444-444444444444',
            choice: 'option-a',
            created_at: '2026-02-10T00:00:00.000Z',
            user_id: 'must-not-escape-vote-owner',
          },
        ]
      }
      if (dataset.name === 'bookmarks.folders') {
        return [
          {
            id: '55555555-5555-4555-8555-555555555555',
            name: 'Research',
            description: 'Saved research posts',
            avatar_url: null,
            is_default: false,
            is_public: false,
            post_count: 1,
            created_at: '2026-02-11T00:00:00.000Z',
            updated_at: '2026-02-12T00:00:00.000Z',
            user_id: 'must-not-escape-folder-owner',
          },
        ]
      }
      if (dataset.name === 'bookmarks.posts') {
        return [
          {
            id: '66666666-6666-4666-8666-666666666666',
            post_id: '77777777-7777-4777-8777-777777777777',
            folder_id: '55555555-5555-4555-8555-555555555555',
            created_at: '2026-02-13T00:00:00.000Z',
            user_id: 'must-not-escape-bookmark-owner',
          },
        ]
      }
      if (dataset.name === 'trading.copy_configs') {
        return [
          {
            id: '88888888-8888-4888-8888-888888888888',
            trader_id: 'trader-alpha',
            exchange: 'binance',
            settings: {
              maxPositionSize: 1000,
              leverageLimit: 3,
              stopLossPercent: 5,
              takeProfitPercent: 10,
              proportionalSize: 50,
              maxDailyLoss: 100,
              maxOpenPositions: 4,
              allowedPairs: ['BTCUSDT'],
              blockedPairs: ['DOGEUSDT'],
              apiSecret: 'must-not-escape-copy-settings',
            },
            active: true,
            created_at: '2026-02-14T00:00:00.000Z',
            updated_at: '2026-02-15T00:00:00.000Z',
            user_id: 'must-not-escape-copy-owner',
          },
        ]
      }
      if (dataset.name === 'trading.watchlist') {
        return [
          {
            id: '99999999-9999-4999-8999-999999999999',
            source: 'hyperliquid',
            source_trader_id: '0xtrader',
            handle: 'alpha',
            created_at: '2026-02-16T00:00:00.000Z',
            user_id: 'must-not-escape-watchlist-owner',
          },
        ]
      }
      if (dataset.name === 'trading.alerts') {
        return [
          {
            id: '12121212-1212-4212-8212-121212121212',
            trader_id: 'trader-beta',
            source: 'binance_futures',
            enabled: true,
            alert_roi_change: true,
            roi_change_threshold: '10.000000000000000001',
            alert_drawdown: true,
            drawdown_threshold: '20',
            alert_pnl_change: false,
            pnl_change_threshold: '5000.123456789012345678',
            alert_score_change: true,
            score_change_threshold: '5.25',
            alert_rank_change: false,
            rank_change_threshold: 5,
            alert_new_position: true,
            alert_price_above: false,
            price_above_value: null,
            alert_price_below: true,
            price_below_value: '9007199254740993.0000000001',
            price_symbol: 'BTCUSDT',
            last_triggered_at: '2026-02-16T01:00:00.000Z',
            one_time: false,
            read_at: null,
            created_at: '2026-02-16T00:00:00.000Z',
            updated_at: '2026-02-16T00:30:00.000Z',
            user_id: 'must-not-escape-alert-owner',
            future_secret: 'must-not-escape-alert-normalization',
          },
        ]
      }
      if (dataset.name === 'groups.applications') {
        return [
          {
            id: '13131313-1313-4313-8313-131313131313',
            name: 'Quant Research',
            name_en: 'Quant Research',
            description: 'A research group',
            description_en: null,
            avatar_url: 'https://cdn.example.test/group.png',
            role_names: { admin: { en: 'Lead' }, member: { en: 'Researcher' } },
            rules: 'Be rigorous',
            rules_json: [{ zh: '引用来源', en: 'Cite sources' }],
            is_premium_only: true,
            status: 'rejected',
            reject_reason: 'Please provide more detail',
            group_id: null,
            reviewed_at: '2026-02-16T02:00:00.000Z',
            created_at: '2026-02-16T01:30:00.000Z',
            applicant_id: 'must-not-escape-application-owner',
            reviewed_by: 'must-not-escape-application-reviewer',
            future_secret: 'must-not-escape-application-normalization',
          },
        ]
      }
      if (dataset.name === 'collections.owned') {
        return [
          {
            id: '14141414-1414-4414-8414-141414141414',
            name: 'My Signals',
            description: 'Signals to revisit',
            is_public: false,
            created_at: '2026-02-16T02:30:00.000Z',
            updated_at: '2026-02-16T03:00:00.000Z',
            user_id: 'must-not-escape-collection-owner',
            future_secret: 'must-not-escape-collection-normalization',
          },
        ]
      }
      if (dataset.name === 'notifications') {
        return [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            type: 'follow',
            title: 'New follower',
            message: 'Someone followed you',
            link: '/u/follower',
            read: false,
            actor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            reference_id: null,
            created_at: '2026-02-17T00:00:00.000Z',
            read_at: null,
            user_id: 'must-not-escape-notification-owner',
            last_error: 'must-not-escape-notification-error',
          },
        ]
      }
      if (dataset.name === 'interactions.comment_likes') {
        return [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            comment_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            reaction_type: 'like',
            created_at: '2026-02-18T00:00:00.000Z',
            user_id: 'must-not-escape-comment-like-owner',
          },
        ]
      }
      if (dataset.name === 'interactions.post_emoji_reactions') {
        return [
          {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            post_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            emoji: '🚀',
            created_at: '2026-02-19T00:00:00.000Z',
            user_id: 'must-not-escape-emoji-owner',
          },
        ]
      }
      throw new Error(`Unexpected cursor dataset: ${dataset.name}`)
    })
    mockFetchAllExportRowsForUuidParents.mockResolvedValue([
      {
        id: '15151515-1515-4515-8515-151515151515',
        collection_id: '14141414-1414-4414-8414-141414141414',
        item_type: 'post',
        item_id: '16161616-1616-4616-8616-161616161616',
        note: 'Compare this later',
        added_at: '2026-02-16T03:30:00.000Z',
        future_secret: 'must-not-escape-collection-item-normalization',
        expanded_post_content: 'must-not-expand-third-party-content',
      },
    ])
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
      notifications: 1,
      'follows.following': 1,
      'follows.followers': 1,
      'blocks.outgoing': 1,
      'tips.sent': 1,
      'tips.received': 1,
      'interactions.post_likes': 1,
      'interactions.post_votes': 1,
      'interactions.comment_likes': 1,
      'interactions.post_emoji_reactions': 1,
      'bookmarks.folders': 1,
      'bookmarks.posts': 1,
      'trading.copy_configs': 1,
      'trading.watchlist': 1,
      'trading.alerts': 1,
      'groups.applications': 1,
      'collections.owned': 1,
      'collections.items': 1,
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
    expect(body.notifications).toEqual([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        type: 'follow',
        title: 'New follower',
        message: 'Someone followed you',
        link: '/u/follower',
        read: false,
        actor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        reference_id: null,
        created_at: '2026-02-17T00:00:00.000Z',
        read_at: null,
      },
    ])
    expect(JSON.stringify(body.notifications)).not.toMatch(
      /must-not-escape-notification-owner|must-not-escape-notification-error|user_id|last_error/
    )
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
    expect(body.interactions).toEqual({
      post_likes: [
        {
          post_id: '33333333-3333-4333-8333-333333333333',
          reaction_type: 'like',
          created_at: '2026-02-09T00:00:00.000Z',
        },
      ],
      post_votes: [
        {
          post_id: '44444444-4444-4444-8444-444444444444',
          choice: 'option-a',
          created_at: '2026-02-10T00:00:00.000Z',
        },
      ],
      comment_likes: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          comment_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          reaction_type: 'like',
          created_at: '2026-02-18T00:00:00.000Z',
        },
      ],
      post_emoji_reactions: [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          post_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          emoji: '🚀',
          created_at: '2026-02-19T00:00:00.000Z',
        },
      ],
    })
    expect(JSON.stringify(body.interactions)).not.toMatch(
      /must-not-escape-like-owner|must-not-escape-vote-owner|must-not-escape-comment-like-owner|must-not-escape-emoji-owner|user_id/
    )
    expect(body.bookmarks).toEqual({
      folders: [
        {
          id: '55555555-5555-4555-8555-555555555555',
          name: 'Research',
          description: 'Saved research posts',
          avatar_url: null,
          is_default: false,
          is_public: false,
          post_count: 1,
          created_at: '2026-02-11T00:00:00.000Z',
          updated_at: '2026-02-12T00:00:00.000Z',
        },
      ],
      posts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          post_id: '77777777-7777-4777-8777-777777777777',
          folder_id: '55555555-5555-4555-8555-555555555555',
          created_at: '2026-02-13T00:00:00.000Z',
        },
      ],
    })
    expect(JSON.stringify(body.bookmarks)).not.toMatch(
      /must-not-escape-folder-owner|must-not-escape-bookmark-owner|user_id/
    )
    expect(body.trading).toEqual({
      copy_configs: [
        {
          id: '88888888-8888-4888-8888-888888888888',
          trader_id: 'trader-alpha',
          exchange: 'binance',
          settings: {
            maxPositionSize: 1000,
            leverageLimit: 3,
            stopLossPercent: 5,
            takeProfitPercent: 10,
            proportionalSize: 50,
            maxDailyLoss: 100,
            maxOpenPositions: 4,
            allowedPairs: ['BTCUSDT'],
            blockedPairs: ['DOGEUSDT'],
          },
          active: true,
          created_at: '2026-02-14T00:00:00.000Z',
          updated_at: '2026-02-15T00:00:00.000Z',
        },
      ],
      watchlist: [
        {
          id: '99999999-9999-4999-8999-999999999999',
          source: 'hyperliquid',
          source_trader_id: '0xtrader',
          handle: 'alpha',
          created_at: '2026-02-16T00:00:00.000Z',
        },
      ],
      alerts: [
        {
          id: '12121212-1212-4212-8212-121212121212',
          trader_id: 'trader-beta',
          source: 'binance_futures',
          enabled: true,
          alert_roi_change: true,
          roi_change_threshold: '10.000000000000000001',
          alert_drawdown: true,
          drawdown_threshold: '20',
          alert_pnl_change: false,
          pnl_change_threshold: '5000.123456789012345678',
          alert_score_change: true,
          score_change_threshold: '5.25',
          alert_rank_change: false,
          rank_change_threshold: 5,
          alert_new_position: true,
          alert_price_above: false,
          price_above_value: null,
          alert_price_below: true,
          price_below_value: '9007199254740993.0000000001',
          price_symbol: 'BTCUSDT',
          last_triggered_at: '2026-02-16T01:00:00.000Z',
          one_time: false,
          read_at: null,
          created_at: '2026-02-16T00:00:00.000Z',
          updated_at: '2026-02-16T00:30:00.000Z',
        },
      ],
    })
    expect(JSON.stringify(body.trading)).not.toMatch(
      /must-not-escape-copy-settings|must-not-escape-copy-owner|must-not-escape-watchlist-owner|must-not-escape-alert-owner|must-not-escape-alert-normalization|apiSecret|future_secret|user_id/
    )
    expect(body.groups).toEqual({
      applications: [
        {
          id: '13131313-1313-4313-8313-131313131313',
          name: 'Quant Research',
          name_en: 'Quant Research',
          description: 'A research group',
          description_en: null,
          avatar_url: 'https://cdn.example.test/group.png',
          role_names: { admin: { en: 'Lead' }, member: { en: 'Researcher' } },
          rules: 'Be rigorous',
          rules_json: [{ zh: '引用来源', en: 'Cite sources' }],
          is_premium_only: true,
          status: 'rejected',
          reject_reason: 'Please provide more detail',
          group_id: null,
          reviewed_at: '2026-02-16T02:00:00.000Z',
          created_at: '2026-02-16T01:30:00.000Z',
        },
      ],
    })
    expect(JSON.stringify(body.groups)).not.toMatch(
      /must-not-escape-application-owner|must-not-escape-application-reviewer|must-not-escape-application-normalization|applicant_id|reviewed_by|future_secret/
    )
    expect(body.collections).toEqual({
      owned: [
        {
          id: '14141414-1414-4414-8414-141414141414',
          name: 'My Signals',
          description: 'Signals to revisit',
          is_public: false,
          created_at: '2026-02-16T02:30:00.000Z',
          updated_at: '2026-02-16T03:00:00.000Z',
        },
      ],
      items: [
        {
          id: '15151515-1515-4515-8515-151515151515',
          collection_id: '14141414-1414-4414-8414-141414141414',
          item_type: 'post',
          item_id: '16161616-1616-4616-8616-161616161616',
          note: 'Compare this later',
          added_at: '2026-02-16T03:30:00.000Z',
        },
      ],
    })
    expect(JSON.stringify(body.collections)).not.toMatch(
      /must-not-escape-collection-owner|must-not-escape-collection-normalization|must-not-escape-collection-item-normalization|must-not-expand-third-party-content|user_id|future_secret|expanded_post_content/
    )
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
    expect(mockFetchAllExportRowsByCursor).toHaveBeenCalledTimes(15)
    expect(mockFetchAllExportRowsForUuidParents).toHaveBeenCalledTimes(1)
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

    for (const interactionName of ['interactions.post_likes', 'interactions.post_votes']) {
      const interactionCall = mockFetchAllExportRowsByCursor.mock.calls.find(
        (call) => call[1].name === interactionName
      )
      expect(interactionCall).toBeDefined()
      expect(interactionCall[2]).toBe(USER_ID)
      expect(interactionCall[1].ownerPredicate).toEqual({
        column: 'user_id',
        operator: 'eq',
        valueType: 'uuid',
      })
      expect(interactionCall[1].cursor).toEqual({
        order: 'asc',
        columns: [{ column: 'post_id', valueType: 'uuid' }],
      })
      expect(interactionCall[1].selectColumns).not.toContain('user_id')
    }

    for (const bookmarkName of ['bookmarks.folders', 'bookmarks.posts']) {
      const bookmarkCall = mockFetchAllExportRowsByCursor.mock.calls.find(
        (call) => call[1].name === bookmarkName
      )
      expect(bookmarkCall).toBeDefined()
      expect(bookmarkCall[2]).toBe(USER_ID)
      expect(bookmarkCall[1].ownerPredicate).toEqual({
        column: 'user_id',
        operator: 'eq',
        valueType: 'uuid',
      })
      expect(bookmarkCall[1].cursor).toEqual({
        order: 'asc',
        columns: [{ column: 'id', valueType: 'uuid' }],
      })
      expect(bookmarkCall[1].selectColumns).not.toContain('user_id')
      expect(bookmarkCall[1].selectColumns).not.toContain('*')
    }

    const copyConfigsCall = mockFetchAllExportRowsByCursor.mock.calls.find(
      (call) => call[1].name === 'trading.copy_configs'
    )
    expect(copyConfigsCall).toBeDefined()
    expect(copyConfigsCall[2]).toBe(USER_ID)
    expect(copyConfigsCall[1].cursor).toEqual({
      order: 'asc',
      columns: [
        { column: 'trader_id', valueType: 'string' },
        { column: 'exchange', valueType: 'string' },
      ],
    })
    expect(copyConfigsCall[1].selectColumns).not.toContain('user_id')

    const watchlistCall = mockFetchAllExportRowsByCursor.mock.calls.find(
      (call) => call[1].name === 'trading.watchlist'
    )
    expect(watchlistCall).toBeDefined()
    expect(watchlistCall[2]).toBe(USER_ID)
    expect(watchlistCall[1].cursor).toEqual({
      order: 'asc',
      columns: [
        { column: 'source', valueType: 'string' },
        { column: 'source_trader_id', valueType: 'string' },
      ],
    })
    expect(watchlistCall[1].selectColumns).not.toContain('user_id')

    const alertsCall = mockFetchAllExportRowsByCursor.mock.calls.find(
      (call) => call[1].name === 'trading.alerts'
    )
    expect(alertsCall).toBeDefined()
    expect(alertsCall[2]).toBe(USER_ID)
    expect(alertsCall[1]).toEqual(
      expect.objectContaining({
        table: 'trader_alerts',
        ownerPredicate: { column: 'user_id', operator: 'eq', valueType: 'uuid' },
        cursor: {
          order: 'asc',
          columns: [{ column: 'id', valueType: 'uuid' }],
        },
        textCastColumns: [
          'roi_change_threshold',
          'drawdown_threshold',
          'pnl_change_threshold',
          'score_change_threshold',
          'price_above_value',
          'price_below_value',
        ],
      })
    )
    expect(alertsCall[1].selectColumns).not.toContain('user_id')
    expect(alertsCall[1].selectColumns).not.toContain('*')

    const groupApplicationsCall = mockFetchAllExportRowsByCursor.mock.calls.find(
      (call) => call[1].name === 'groups.applications'
    )
    expect(groupApplicationsCall).toBeDefined()
    expect(groupApplicationsCall[2]).toBe(USER_ID)
    expect(groupApplicationsCall[1]).toEqual(
      expect.objectContaining({
        table: 'group_applications',
        ownerPredicate: { column: 'applicant_id', operator: 'eq', valueType: 'uuid' },
        cursor: {
          order: 'asc',
          columns: [{ column: 'id', valueType: 'uuid' }],
        },
      })
    )
    expect(groupApplicationsCall[1].selectColumns).not.toContain('applicant_id')
    expect(groupApplicationsCall[1].selectColumns).not.toContain('reviewed_by')
    expect(groupApplicationsCall[1].selectColumns).not.toContain('*')

    const ownedCollectionsCall = mockFetchAllExportRowsByCursor.mock.calls.find(
      (call) => call[1].name === 'collections.owned'
    )
    expect(ownedCollectionsCall).toBeDefined()
    expect(ownedCollectionsCall[2]).toBe(USER_ID)
    expect(ownedCollectionsCall[1]).toEqual({
      name: 'collections.owned',
      table: 'user_collections',
      selectColumns: ['id', 'name', 'description', 'is_public', 'created_at', 'updated_at'],
      ownerPredicate: { column: 'user_id', operator: 'eq', valueType: 'uuid' },
      cursor: {
        order: 'asc',
        columns: [{ column: 'id', valueType: 'uuid' }],
      },
    })
    expect(ownedCollectionsCall[1].selectColumns).not.toContain('user_id')

    const collectionItemsCall = mockFetchAllExportRowsForUuidParents.mock.calls[0]
    expect(collectionItemsCall[2]).toEqual(['14141414-1414-4414-8414-141414141414'])
    expect(collectionItemsCall[1]).toEqual({
      name: 'collections.items',
      table: 'collection_items',
      selectColumns: ['id', 'collection_id', 'item_type', 'item_id', 'note', 'added_at'],
      ownerPredicate: { column: 'collection_id', operator: 'eq', valueType: 'uuid' },
      cursor: {
        order: 'asc',
        columns: [{ column: 'id', valueType: 'uuid' }],
      },
    })
    expect(collectionItemsCall[1].selectColumns).not.toContain('*')

    for (const ownerIdDatasetName of [
      'notifications',
      'interactions.comment_likes',
      'interactions.post_emoji_reactions',
    ]) {
      const datasetCall = mockFetchAllExportRowsByCursor.mock.calls.find(
        (call) => call[1].name === ownerIdDatasetName
      )
      expect(datasetCall).toBeDefined()
      expect(datasetCall[2]).toBe(USER_ID)
      expect(datasetCall[1].ownerPredicate).toEqual({
        column: 'user_id',
        operator: 'eq',
        valueType: 'uuid',
      })
      expect(datasetCall[1].cursor).toEqual({
        order: 'asc',
        columns: [{ column: 'id', valueType: 'uuid' }],
      })
      expect(datasetCall[1].selectColumns).not.toContain('user_id')
      expect(datasetCall[1].selectColumns).not.toContain('*')
    }
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

  it('fails closed without cooldown when post interactions cannot be read completely', async () => {
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, dataset) => {
      if (dataset.name === 'interactions.post_likes') {
        throw new DataExportReadError('interactions.post_likes', { code: 'XX001' })
      }
      return []
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed without cooldown when bookmarks cannot be read completely', async () => {
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, dataset) => {
      if (dataset.name === 'bookmarks.posts') {
        throw new DataExportReadError('bookmarks.posts', { code: 'XX001' })
      }
      return []
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed without cooldown when copy settings have an unsafe runtime shape', async () => {
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, dataset) => {
      if (dataset.name === 'trading.copy_configs') {
        return [
          {
            id: '88888888-8888-4888-8888-888888888888',
            trader_id: 'trader-alpha',
            exchange: 'binance',
            settings: { allowedPairs: [42] },
            active: true,
            created_at: '2026-02-14T00:00:00.000Z',
            updated_at: '2026-02-15T00:00:00.000Z',
          },
        ]
      }
      return []
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed without cooldown when notification history cannot be read', async () => {
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, dataset) => {
      if (dataset.name === 'notifications') {
        throw new DataExportReadError('notifications', { code: 'XX001' })
      }
      return []
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed without cooldown when trader alerts cannot be read completely', async () => {
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, dataset) => {
      if (dataset.name === 'trading.alerts') {
        throw new DataExportReadError('trading.alerts', { code: 'XX001' })
      }
      return []
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed without cooldown when group applications cannot be read completely', async () => {
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, dataset) => {
      if (dataset.name === 'groups.applications') {
        throw new DataExportReadError('groups.applications', { code: 'XX001' })
      }
      return []
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed without cooldown when owned collection items cannot be read completely', async () => {
    mockFetchAllExportRowsForUuidParents.mockRejectedValueOnce(
      new DataExportReadError('collections.items', { code: 'XX001' })
    )

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
