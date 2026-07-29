import { parseLinkedTraderManagementPayload } from '../linked-trader-management'

const USER_ID = 'user-a'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    user_id: USER_ID,
    trader_id: 'exact-account-id',
    source: 'binance_futures',
    label: 'Primary',
    is_primary: true,
    display_order: 0,
    verified_at: '2026-07-29T00:00:00.000Z',
    verification_method: 'api_key',
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    stats: null,
    ...overrides,
  }
}

function payload(rows: unknown[], count: unknown = rows.length) {
  return { linked_traders: rows, count }
}

describe('linked trader management DTO', () => {
  it('accepts an exact list and rebuilds only the management fields', () => {
    expect(parseLinkedTraderManagementPayload(payload([row()]), USER_ID)).toEqual([
      {
        id: 'aaaaaaaa-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        user_id: USER_ID,
        trader_id: 'exact-account-id',
        source: 'binance_futures',
        label: 'Primary',
        is_primary: true,
        verified_at: '2026-07-29T00:00:00.000Z',
        verification_method: 'api_key',
        stats: null,
      },
    ])
  })

  it('accepts the authoritative empty membership state', () => {
    expect(parseLinkedTraderManagementPayload(payload([]), USER_ID)).toEqual([])
  })

  it('rejects a count mismatch or a foreign owner', () => {
    expect(parseLinkedTraderManagementPayload(payload([row()], 0), USER_ID)).toBeNull()
    expect(
      parseLinkedTraderManagementPayload(payload([row({ user_id: 'user-b' })]), USER_ID)
    ).toBeNull()
  })

  it('rejects unbound legacy metrics even when every number looks valid', () => {
    expect(
      parseLinkedTraderManagementPayload(
        payload([
          row({
            stats: {
              arena_score: 80,
              roi: 12,
              pnl: 50,
              rank: 1,
              handle: 'Alias',
              avatar_url: null,
            },
          }),
        ]),
        USER_ID
      )
    ).toBeNull()
  })

  it('rejects duplicate rows by id or exact account identity', () => {
    const secondId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    expect(
      parseLinkedTraderManagementPayload(
        payload([row(), row({ trader_id: 'other', is_primary: false })]),
        USER_ID
      )
    ).toBeNull()
    expect(
      parseLinkedTraderManagementPayload(
        payload([row(), row({ id: secondId, is_primary: false })]),
        USER_ID
      )
    ).toBeNull()
  })

  it('normalizes EVM wallet case only when checking duplicate identity', () => {
    const checksum = '0xAbCdEf0000000000000000000000000000000000'
    expect(
      parseLinkedTraderManagementPayload(
        payload([
          row({ trader_id: checksum, source: 'gmx' }),
          row({
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            trader_id: checksum.toLowerCase(),
            source: 'gmx',
            is_primary: false,
          }),
        ]),
        USER_ID
      )
    ).toBeNull()
  })

  it('requires exactly one primary account for non-empty membership', () => {
    expect(
      parseLinkedTraderManagementPayload(payload([row({ is_primary: false })]), USER_ID)
    ).toBeNull()
    expect(
      parseLinkedTraderManagementPayload(
        payload([
          row(),
          row({
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            trader_id: 'other',
          }),
        ]),
        USER_ID
      )
    ).toBeNull()
  })

  it('rejects malformed identity, label, and timestamp fields', () => {
    expect(
      parseLinkedTraderManagementPayload(payload([row({ trader_id: ' ' })]), USER_ID)
    ).toBeNull()
    expect(parseLinkedTraderManagementPayload(payload([row({ label: '' })]), USER_ID)).toBeNull()
    expect(
      parseLinkedTraderManagementPayload(payload([row({ verified_at: 'invalid' })]), USER_ID)
    ).toBeNull()
  })
})
