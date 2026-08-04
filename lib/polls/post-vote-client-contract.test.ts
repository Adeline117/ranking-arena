import {
  POST_BUILT_IN_VOTE_OPERATION,
  POST_CUSTOM_POLL_READ_OPERATION,
  POST_CUSTOM_POLL_VOTE_OPERATION,
  createPostVoteRequestId,
  readPostBuiltInVoteAcknowledgement,
  readPostCustomPollAcknowledgement,
  readPostCustomPollVoteAcknowledgement,
} from './post-vote-client-contract'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const POLL_ID = '33333333-3333-4333-8333-333333333333'
const REQUEST_ID = 'a'.repeat(32)

function builtInReceipt(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: ACTOR_ID,
    post_id: POST_ID,
    request_id: REQUEST_ID,
    operation: POST_BUILT_IN_VOTE_OPERATION,
    requested_choice: 'bull',
    action: 'added',
    vote: 'bull',
    poll: { bull: 2, bear: 1, wait: 0 },
    ...overrides,
  }
}

function readReceipt(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: ACTOR_ID,
    post_id: POST_ID,
    request_id: REQUEST_ID,
    operation: POST_CUSTOM_POLL_READ_OPERATION,
    action: 'found',
    poll: {
      id: POLL_ID,
      question: 'Direction?',
      options: [
        { text: 'Up', votes: 2 },
        { text: 'Down', votes: 1 },
      ],
      type: 'single',
      end_at: null,
      is_expired: false,
      show_results: true,
      total_votes: 3,
    },
    user_votes: [0],
    ...overrides,
  }
}

function voteReceipt(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: ACTOR_ID,
    post_id: POST_ID,
    poll_id: POLL_ID,
    request_id: REQUEST_ID,
    operation: POST_CUSTOM_POLL_VOTE_OPERATION,
    action: 'voted',
    poll: {
      options: [
        { text: 'Up', votes: 2 },
        { text: 'Down', votes: 1 },
      ],
      total_votes: 3,
    },
    option_indexes: [0],
    ...overrides,
  }
}

describe('post vote client contracts', () => {
  it('generates canonical opaque request nonces', () => {
    expect(createPostVoteRequestId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('accepts the exact built-in toggle receipt with absolute counts', () => {
    expect(
      readPostBuiltInVoteAcknowledgement(builtInReceipt(), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
        choice: 'bull',
      })
    ).toMatchObject({ action: 'added', vote: 'bull', poll: { bull: 2, bear: 1, wait: 0 } })
  })

  it.each([
    ['another actor', { actor_id: POLL_ID }],
    ['another post', { post_id: POLL_ID }],
    ['another nonce', { request_id: 'b'.repeat(32) }],
    ['another choice', { requested_choice: 'bear' }],
    ['an impossible removed result', { action: 'removed', vote: 'bull' }],
    ['a negative count', { poll: { bull: -1, bear: 1, wait: 0 } }],
    ['an extra field', { invented: true }],
  ])('rejects a built-in receipt with %s', (_name, overrides) => {
    expect(
      readPostBuiltInVoteAcknowledgement(builtInReceipt(overrides), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
        choice: 'bull',
      })
    ).toBeNull()
  })

  it('accepts exact found and absent custom-poll snapshots', () => {
    expect(
      readPostCustomPollAcknowledgement(readReceipt(), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
      })
    ).toMatchObject({ action: 'found', userVotes: [0], poll: { id: POLL_ID, totalVotes: 3 } })

    expect(
      readPostCustomPollAcknowledgement(
        readReceipt({ action: 'absent', poll: null, user_votes: [] }),
        { actorId: ACTOR_ID, postId: POST_ID, requestId: REQUEST_ID }
      )
    ).toMatchObject({ action: 'absent', poll: null, userVotes: [] })
  })

  it.each([
    ['another viewer', { actor_id: POLL_ID }],
    ['another post', { post_id: POLL_ID }],
    ['another nonce', { request_id: 'b'.repeat(32) }],
    ['out-of-order viewer selections', { user_votes: [1, 0] }],
    ['a mismatched total', { poll: { ...readReceipt().poll, total_votes: 2 } }],
    ['results exposed before expiry or a viewer vote', { user_votes: [] }],
    ['an expired permanent poll', { poll: { ...readReceipt().poll, is_expired: true } }],
    [
      'leaked hidden counts',
      {
        poll: {
          ...readReceipt().poll,
          options: [
            { text: 'Up', votes: 2 },
            { text: 'Down', votes: null },
          ],
          show_results: false,
          total_votes: null,
        },
        user_votes: [],
      },
    ],
    ['an extra field', { invented: true }],
  ])('rejects a custom-poll read receipt with %s', (_name, overrides) => {
    expect(
      readPostCustomPollAcknowledgement(readReceipt(overrides), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
      })
    ).toBeNull()
  })

  it('accepts the exact custom-poll replacement receipt', () => {
    expect(
      readPostCustomPollVoteAcknowledgement(voteReceipt(), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        pollId: POLL_ID,
        requestId: REQUEST_ID,
        pollType: 'single',
        optionTexts: ['Up', 'Down'],
        optionIndexes: [0],
      })
    ).toMatchObject({ action: 'voted', optionIndexes: [0], totalVotes: 3 })
  })

  it.each([
    ['another poll', { poll_id: ACTOR_ID }],
    ['another nonce', { request_id: 'b'.repeat(32) }],
    [
      'reordered option labels',
      {
        poll: {
          ...voteReceipt().poll,
          options: [
            { text: 'Down', votes: 1 },
            { text: 'Up', votes: 2 },
          ],
        },
      },
    ],
    ['a mismatched total', { poll: { ...voteReceipt().poll, total_votes: 2 } }],
    ['different selections', { option_indexes: [1] }],
    ['an extra field', { invented: true }],
  ])('rejects a custom-poll vote receipt with %s', (_name, overrides) => {
    expect(
      readPostCustomPollVoteAcknowledgement(voteReceipt(overrides), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        pollId: POLL_ID,
        requestId: REQUEST_ID,
        pollType: 'single',
        optionTexts: ['Up', 'Down'],
        optionIndexes: [0],
      })
    ).toBeNull()
  })
})
