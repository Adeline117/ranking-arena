import {
  GroupPostPaginationLedger,
  appendUniqueGroupPosts,
  buildGroupPostCursorFilter,
  groupPostCursorFromPage,
} from '../post-pagination-client'

type TestPost = {
  id: string
  created_at: string
  is_pinned?: boolean | null
}

const SCOPE_A = 'group-a'
const SCOPE_B = 'group-b'
const TIMESTAMP = '2026-07-29T12:00:00.123456Z'
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

describe('group manage post pagination', () => {
  it('single-flights same-frame load-more calls in the exact scope and cursor', () => {
    const ledger = new GroupPostPaginationLedger()
    ledger.reset(SCOPE_A, [{ id: ID_B, created_at: TIMESTAMP, is_pinned: false }])

    const first = ledger.begin(SCOPE_A)
    const duplicate = ledger.begin(SCOPE_A)

    expect(first).not.toBeNull()
    expect(duplicate).toBeNull()
    expect(ledger.finish(first!)).toBe(true)
    expect(ledger.begin(SCOPE_A)).not.toBeNull()
  })

  it('does not let a late request release or advance another group scope', () => {
    const ledger = new GroupPostPaginationLedger()
    ledger.reset(SCOPE_A, [{ id: ID_B, created_at: TIMESTAMP, is_pinned: false }])
    ledger.reset(SCOPE_B, [{ id: ID_A, created_at: TIMESTAMP, is_pinned: true }])
    const requestA = ledger.begin(SCOPE_A)
    const requestB = ledger.begin(SCOPE_B)

    expect(ledger.advance(requestA!, [{ id: ID_A, created_at: TIMESTAMP, is_pinned: false }])).toBe(
      true
    )
    expect(ledger.finish(requestA!)).toBe(true)
    expect(ledger.begin(SCOPE_B)).toBeNull()
    expect(ledger.cursor(SCOPE_B)).toEqual({
      createdAt: TIMESTAMP,
      id: ID_A,
      isPinned: true,
    })
    expect(ledger.finish(requestB!)).toBe(true)
  })

  it('deduplicates overlapping pages without overwriting local moderation state', () => {
    const existing = [
      { id: ID_A, created_at: TIMESTAMP, is_pinned: false, deleted_at: 'locally-deleted' },
    ]
    const incoming = [
      { id: ID_A, created_at: TIMESTAMP, is_pinned: true, deleted_at: null },
      { id: ID_B, created_at: TIMESTAMP, is_pinned: false, deleted_at: null },
      { id: ID_B, created_at: TIMESTAMP, is_pinned: false, deleted_at: null },
    ]

    expect(appendUniqueGroupPosts(existing, incoming)).toEqual([existing[0], incoming[1]])
  })

  it('uses id as a descending tie-breaker for posts sharing a timestamp', () => {
    const cursor = groupPostCursorFromPage<TestPost>([
      { id: ID_B, created_at: TIMESTAMP, is_pinned: false },
    ])

    expect(buildGroupPostCursorFilter(cursor!)).toBe(
      `and(is_pinned.eq.false,created_at.lt."${TIMESTAMP}"),` +
        `and(is_pinned.eq.false,created_at.eq."${TIMESTAMP}",id.lt.${ID_B}),` +
        'is_pinned.is.null'
    )
  })

  it('continues through nullable pin buckets in the same order as the initial query', () => {
    expect(buildGroupPostCursorFilter({ createdAt: TIMESTAMP, id: ID_B, isPinned: true })).toBe(
      `and(is_pinned.eq.true,created_at.lt."${TIMESTAMP}"),` +
        `and(is_pinned.eq.true,created_at.eq."${TIMESTAMP}",id.lt.${ID_B}),` +
        'is_pinned.eq.false,is_pinned.is.null'
    )
    expect(buildGroupPostCursorFilter({ createdAt: TIMESTAMP, id: ID_B, isPinned: null })).toBe(
      `and(is_pinned.is.null,created_at.lt."${TIMESTAMP}"),` +
        `and(is_pinned.is.null,created_at.eq."${TIMESTAMP}",id.lt.${ID_B})`
    )
  })
})
