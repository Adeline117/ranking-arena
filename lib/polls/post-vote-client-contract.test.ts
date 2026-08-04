import {
  POST_BUILT_IN_VOTE_OPERATION,
  POST_CUSTOM_POLL_READ_OPERATION,
  POST_CUSTOM_POLL_VOTE_OPERATION,
  createPostVoteRequestId,
  isDefinitivePostBuiltInVoteRejection,
  nextPostBuiltInVoteState,
  postBuiltInVoteCountDelta,
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
    desired_choice: 'bull',
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

  it('accepts the exact built-in desired-state receipt with absolute counts', () => {
    expect(
      readPostBuiltInVoteAcknowledgement(builtInReceipt(), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
        desiredChoice: 'bull',
      })
    ).toMatchObject({ action: 'added', vote: 'bull', poll: { bull: 2, bear: 1, wait: 0 } })
  })

  it.each([
    ['another actor', { actor_id: POLL_ID }],
    ['another post', { post_id: POLL_ID }],
    ['another nonce', { request_id: 'b'.repeat(32) }],
    ['another desired choice', { desired_choice: 'bear' }],
    ['an impossible removed result', { action: 'removed', vote: 'bull' }],
    ['a negative count', { poll: { bull: -1, bear: 1, wait: 0 } }],
    ['an extra field', { invented: true }],
  ])('rejects a built-in receipt with %s', (_name, overrides) => {
    expect(
      readPostBuiltInVoteAcknowledgement(builtInReceipt(overrides), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
        desiredChoice: 'bull',
      })
    ).toBeNull()
  })

  it.each([
    [
      'an unchanged replay',
      { action: 'unchanged' },
      { desiredChoice: 'bull' as const, action: 'unchanged', vote: 'bull' },
    ],
    [
      'an explicit removal',
      {
        desired_choice: null,
        action: 'removed',
        vote: null,
        poll: { bull: 0, bear: 1, wait: 0 },
      },
      { desiredChoice: null, action: 'removed', vote: null },
    ],
    [
      'an unchanged absence',
      {
        desired_choice: null,
        action: 'unchanged',
        vote: null,
        poll: { bull: 0, bear: 1, wait: 0 },
      },
      { desiredChoice: null, action: 'unchanged', vote: null },
    ],
  ])('accepts %s without toggle semantics', (_name, overrides, expectedResult) => {
    expect(
      readPostBuiltInVoteAcknowledgement(builtInReceipt(overrides), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
        desiredChoice: expectedResult.desiredChoice,
      })
    ).toMatchObject(expectedResult)
  })

  it.each([
    ['a removed action for a desired vote', { action: 'removed', vote: null }],
    ['an added action for desired absence', { desired_choice: null, action: 'added', vote: null }],
    ['a mismatched result', { vote: 'bear' }],
    ['an impossible zero own-choice count', { poll: { bull: 0, bear: 1, wait: 0 } }],
  ])('rejects %s', (_name, overrides) => {
    expect(
      readPostBuiltInVoteAcknowledgement(builtInReceipt(overrides), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
        desiredChoice: 'bull',
      })
    ).toBeNull()
  })

  it.each([
    [null, 'bull', 'bull'],
    ['bull', 'bull', null],
    ['bear', 'bull', 'bull'],
    [null, 'wait', 'wait'],
  ] as const)('maps built-in vote intent %s + %s to %s', (current, selected, desired) => {
    expect(nextPostBuiltInVoteState(current, selected)).toBe(desired)
  })

  it.each([
    [null, 'bull', 1, 0, 0],
    ['bull', null, -1, 0, 0],
    ['bull', 'bear', -1, 1, 0],
    ['wait', 'bull', 1, 0, -1],
  ] as const)('computes built-in count delta %s -> %s', (current, desired, bull, bear, wait) => {
    expect(postBuiltInVoteCountDelta(current, desired)).toEqual({ bull, bear, wait })
  })

  it.each([400, 401, 403, 404, 409, 422, 429])(
    'treats built-in vote HTTP %i as definitive',
    (status) => expect(isDefinitivePostBuiltInVoteRejection(status)).toBe(true)
  )

  it.each([0, 200, 408, 425, 500, 503])('treats built-in vote HTTP %i as uncertain', (status) =>
    expect(isDefinitivePostBuiltInVoteRejection(status)).toBe(false)
  )

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
