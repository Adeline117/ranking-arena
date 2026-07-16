import {
  GROUP_AUDIT_PAGE_LIMIT,
  loadGroupAuditActivities,
  MAX_GROUP_AUDIT_PAGES,
  type GroupAuditPageFetchResult,
} from '../activity-log-client'

const LOG_1 = '11111111-1111-4111-8111-111111111111'
const LOG_2 = '22222222-2222-4222-8222-222222222222'
const ACTOR = '33333333-3333-4333-8333-333333333333'
const TARGET = '44444444-4444-4444-8444-444444444444'

function page(
  logs: Array<Record<string, unknown>>,
  nextCursor: string | null = null
): GroupAuditPageFetchResult {
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      logs,
      pagination: {
        limit: GROUP_AUDIT_PAGE_LIMIT,
        has_more: nextCursor !== null,
        next_cursor: nextCursor,
      },
    },
  }
}

function row(id: string, action: string, createdAt: string) {
  return {
    id,
    action,
    actor_id: ACTOR,
    target_id: TARGET,
    created_at: createdAt,
  }
}

describe('group audit activity cursor client', () => {
  it('follows the opaque cursor and atomically maps the exact allowlist', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(
        page([row(LOG_1, 'member_kicked', '2026-07-16T20:00:00.000Z')], 'cursor_one')
      )
      .mockResolvedValueOnce(page([row(LOG_2, 'invite_created', '2026-07-16T19:00:00.000Z')]))

    await expect(loadGroupAuditActivities({ fetchPage, isCurrent: () => true })).resolves.toEqual({
      stale: false,
      truncated: false,
      activities: [
        {
          id: LOG_1,
          type: 'member_kicked',
          title: 'member_kicked',
          message: TARGET,
          created_at: '2026-07-16T20:00:00.000Z',
          actor_id: ACTOR,
        },
        {
          id: LOG_2,
          type: 'invite_created',
          title: 'invite_created',
          message: TARGET,
          created_at: '2026-07-16T19:00:00.000Z',
          actor_id: ACTOR,
        },
      ],
    })
    expect(fetchPage.mock.calls).toEqual([[null], ['cursor_one']])
  })

  it('drops the complete batch when ownership changes between pages', async () => {
    let current = true
    const fetchPage = jest.fn().mockImplementation(async (cursor: string | null) => {
      if (cursor) return page([row(LOG_2, 'invite_created', '2026-07-16T19:00:00.000Z')])
      current = false
      return page([row(LOG_1, 'member_kicked', '2026-07-16T20:00:00.000Z')], 'next')
    })

    await expect(
      loadGroupAuditActivities({ fetchPage, isCurrent: () => current })
    ).resolves.toEqual({ activities: [], stale: true, truncated: false })
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('rejects extra private fields and a cursor cycle', async () => {
    await expect(
      loadGroupAuditActivities({
        fetchPage: async () =>
          page([
            {
              ...row(LOG_1, 'member_kicked', '2026-07-16T20:00:00.000Z'),
              details: { private: true },
            },
          ]),
        isCurrent: () => true,
      })
    ).rejects.toThrow('exact client contract')

    await expect(
      loadGroupAuditActivities({
        fetchPage: async () =>
          page([row(LOG_1, 'member_kicked', '2026-07-16T20:00:00.000Z')], 'same_cursor'),
        isCurrent: () => true,
      })
    ).rejects.toThrow('cursor did not advance')
  })

  it('bounds automatic pagination even when the server keeps returning more', async () => {
    let index = 0
    const fetchPage = jest.fn(async () => {
      index += 1
      return page([row(LOG_1, 'member_kicked', '2026-07-16T20:00:00.000Z')], `cursor_${index}`)
    })

    await expect(loadGroupAuditActivities({ fetchPage, isCurrent: () => true })).resolves.toEqual({
      activities: [
        {
          id: LOG_1,
          type: 'member_kicked',
          title: 'member_kicked',
          message: TARGET,
          created_at: '2026-07-16T20:00:00.000Z',
          actor_id: ACTOR,
        },
      ],
      stale: false,
      truncated: true,
    })
    expect(fetchPage).toHaveBeenCalledTimes(MAX_GROUP_AUDIT_PAGES)
  })
})
