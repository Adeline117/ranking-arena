import {
  postBelongsToPinScope,
  postPinScopeKey,
  readPostPinAcknowledgement,
} from './post-pin-client'

const POST_ID = '11111111-1111-4111-8111-111111111111'
const AUTHOR_ID = '22222222-2222-4222-8222-222222222222'
const GROUP_ID = '33333333-3333-4333-8333-333333333333'

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      post_id: POST_ID,
      author_id: AUTHOR_ID,
      group_id: GROUP_ID,
      scope_type: 'group',
      scope_id: GROUP_ID,
      is_pinned: true,
      already_set: false,
      unpinned_count: 1,
      message: 'Pinned',
      ...overrides,
    },
  }
}

describe('post pin client acknowledgement', () => {
  it('accepts only an exact acknowledgement bound to the submitted desired state', () => {
    expect(
      readPostPinAcknowledgement(acknowledgement(), {
        postId: POST_ID,
        groupId: GROUP_ID,
        isPinned: true,
      })
    ).toEqual({
      postId: POST_ID,
      authorId: AUTHOR_ID,
      groupId: GROUP_ID,
      scopeType: 'group',
      scopeId: GROUP_ID,
      isPinned: true,
      alreadySet: false,
      unpinnedCount: 1,
      message: 'Pinned',
    })
  })

  it.each([
    acknowledgement({ post_id: '44444444-4444-4444-8444-444444444444' }),
    acknowledgement({ is_pinned: false }),
    acknowledgement({ scope_id: AUTHOR_ID }),
    acknowledgement({ scope_type: 'author' }),
    acknowledgement({ message: 'Unpinned' }),
    acknowledgement({ unpinned_count: -1 }),
    acknowledgement({ already_set: true, unpinned_count: 1 }),
    { ...acknowledgement(), extra: true },
    { ...acknowledgement(), data: { ...acknowledgement().data, extra: true } },
  ])('rejects contradictory or non-exact acknowledgements', (value) => {
    expect(
      readPostPinAcknowledgement(value, {
        postId: POST_ID,
        groupId: GROUP_ID,
        isPinned: true,
      })
    ).toBeNull()
  })

  it('accepts an idempotent personal unpin acknowledgement', () => {
    expect(
      readPostPinAcknowledgement(
        acknowledgement({
          group_id: null,
          scope_type: 'author',
          scope_id: AUTHOR_ID,
          is_pinned: false,
          already_set: true,
          unpinned_count: 0,
          message: 'Unpinned',
        }),
        { postId: POST_ID, authorId: AUTHOR_ID, groupId: null, isPinned: false }
      )
    ).toMatchObject({ scopeType: 'author', isPinned: false, alreadySet: true })
  })
})

describe('post pin scope helpers', () => {
  it('uses group scope before author scope', () => {
    expect(postPinScopeKey({ group_id: GROUP_ID, author_id: AUTHOR_ID })).toBe(`group:${GROUP_ID}`)
    expect(postPinScopeKey({ group_id: null, author_id: AUTHOR_ID })).toBe(`author:${AUTHOR_ID}`)
  })

  it('matches only rows in the acknowledged scope', () => {
    const groupAck = readPostPinAcknowledgement(acknowledgement(), {
      postId: POST_ID,
      groupId: GROUP_ID,
      isPinned: true,
    })!
    expect(postBelongsToPinScope({ group_id: GROUP_ID, author_id: AUTHOR_ID }, groupAck)).toBe(true)
    expect(postBelongsToPinScope({ group_id: null, author_id: AUTHOR_ID }, groupAck)).toBe(false)
  })
})
