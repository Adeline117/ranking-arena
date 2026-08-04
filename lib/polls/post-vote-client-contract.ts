const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/

export const POST_VOTE_REQUEST_TIMEOUT_MS = 15_000
export const POST_BUILT_IN_VOTE_OPERATION = 'set_vote' as const
export const POST_CUSTOM_POLL_READ_OPERATION = 'read' as const
export const POST_CUSTOM_POLL_VOTE_OPERATION = 'set_vote' as const

export type PostBuiltInVoteChoice = 'bull' | 'bear' | 'wait'
export type PostBuiltInVoteAction = 'added' | 'removed' | 'changed' | 'unchanged'
export type PostCustomPollType = 'single' | 'multiple'
export type PostCustomPollLoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

export type PostBuiltInVoteAcknowledgement = {
  actorId: string
  postId: string
  requestId: string
  operation: typeof POST_BUILT_IN_VOTE_OPERATION
  desiredChoice: PostBuiltInVoteChoice | null
  action: PostBuiltInVoteAction
  vote: PostBuiltInVoteChoice | null
  poll: { bull: number; bear: number; wait: number }
}

export type PostCustomPoll = {
  id: string
  question: string
  options: { text: string; votes: number | null }[]
  type: PostCustomPollType
  endAt: string | null
  isExpired: boolean
  showResults: boolean
  totalVotes: number | null
}

export type PostCustomPollReadAcknowledgement = {
  actorId: string | null
  postId: string
  requestId: string
  operation: typeof POST_CUSTOM_POLL_READ_OPERATION
  action: 'found' | 'absent'
  poll: PostCustomPoll | null
  userVotes: number[]
}

export type PostCustomPollVoteAcknowledgement = {
  actorId: string
  postId: string
  pollId: string
  requestId: string
  operation: typeof POST_CUSTOM_POLL_VOTE_OPERATION
  action: 'voted'
  options: { text: string; votes: number }[]
  totalVotes: number
  optionIndexes: number[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null
}

function canonicalRequestId(value: unknown): string | null {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : null
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isCanonicalOptionText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 100 &&
    value === value.trim() &&
    value === value.normalize('NFC')
  )
}

function hasUniqueOptionTexts(options: readonly { text: string }[]): boolean {
  const normalized = options.map((option) => option.text.normalize('NFKC').toLowerCase())
  return new Set(normalized).size === normalized.length
}

function readSortedOptionIndexes(
  value: unknown,
  optionCount: number,
  type: PostCustomPollType
): number[] | null {
  if (!Array.isArray(value) || (type === 'single' && value.length > 1)) return null

  const indexes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index]
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < 0 ||
      (candidate as number) >= optionCount ||
      (index > 0 && (candidate as number) <= indexes[index - 1])
    ) {
      return null
    }
    indexes.push(candidate as number)
  }
  return indexes
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function isCanonicalPostVoteRequestId(value: unknown): value is string {
  return canonicalRequestId(value) !== null
}

export function createPostVoteRequestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function nextPostBuiltInVoteState(
  current: PostBuiltInVoteChoice | null,
  selected: PostBuiltInVoteChoice
): PostBuiltInVoteChoice | null {
  return current === selected ? null : selected
}

export function postBuiltInVoteCountDelta(
  current: PostBuiltInVoteChoice | null,
  desired: PostBuiltInVoteChoice | null
): { bull: number; bear: number; wait: number } {
  return {
    bull: Number(desired === 'bull') - Number(current === 'bull'),
    bear: Number(desired === 'bear') - Number(current === 'bear'),
    wait: Number(desired === 'wait') - Number(current === 'wait'),
  }
}

/** A bounded 4xx proves the route rejected the command before commit. */
export function isDefinitivePostBuiltInVoteRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425
}

/**
 * Accept only the identity- and request-bound receipt for this exact desired
 * state. Replaying the command is intrinsically safe and may acknowledge an
 * unchanged state without toggling it away.
 */
export function readPostBuiltInVoteAcknowledgement(
  value: unknown,
  expected: {
    actorId: string
    postId: string
    requestId: string
    desiredChoice: PostBuiltInVoteChoice | null
  }
): PostBuiltInVoteAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'action',
      'actor_id',
      'desired_choice',
      'operation',
      'poll',
      'post_id',
      'request_id',
      'vote',
    ]) ||
    value.operation !== POST_BUILT_IN_VOTE_OPERATION ||
    value.desired_choice !== expected.desiredChoice ||
    (value.action !== 'added' &&
      value.action !== 'removed' &&
      value.action !== 'changed' &&
      value.action !== 'unchanged') ||
    !isRecord(value.poll) ||
    !hasExactKeys(value.poll, ['bear', 'bull', 'wait']) ||
    !isNonnegativeSafeInteger(value.poll.bull) ||
    !isNonnegativeSafeInteger(value.poll.bear) ||
    !isNonnegativeSafeInteger(value.poll.wait)
  ) {
    return null
  }

  const actorId = canonicalUuid(value.actor_id)
  const postId = canonicalUuid(value.post_id)
  const requestId = canonicalRequestId(value.request_id)
  const expectedActorId = canonicalUuid(expected.actorId)
  const expectedPostId = canonicalUuid(expected.postId)
  const expectedRequestId = canonicalRequestId(expected.requestId)
  if (
    !actorId ||
    !postId ||
    !requestId ||
    !expectedActorId ||
    !expectedPostId ||
    !expectedRequestId ||
    actorId !== expectedActorId ||
    postId !== expectedPostId ||
    requestId !== expectedRequestId
  ) {
    return null
  }

  const vote = value.vote
  const validVote =
    vote === expected.desiredChoice &&
    !(
      (value.action === 'removed' && expected.desiredChoice !== null) ||
      ((value.action === 'added' || value.action === 'changed') && expected.desiredChoice === null)
    )
  if (!validVote || (vote !== null && (value.poll[vote as PostBuiltInVoteChoice] as number) < 1)) {
    return null
  }

  return {
    actorId,
    postId,
    requestId,
    operation: POST_BUILT_IN_VOTE_OPERATION,
    desiredChoice: expected.desiredChoice,
    action: value.action,
    vote: vote as PostBuiltInVoteChoice | null,
    poll: {
      bull: value.poll.bull,
      bear: value.poll.bear,
      wait: value.poll.wait,
    },
  }
}

/** Read a viewer-bound custom-poll snapshot, including an explicit absence. */
export function readPostCustomPollAcknowledgement(
  value: unknown,
  expected: { actorId: string | null; postId: string; requestId: string }
): PostCustomPollReadAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'action',
      'actor_id',
      'operation',
      'poll',
      'post_id',
      'request_id',
      'user_votes',
    ]) ||
    value.operation !== POST_CUSTOM_POLL_READ_OPERATION ||
    (value.action !== 'found' && value.action !== 'absent') ||
    !Array.isArray(value.user_votes)
  ) {
    return null
  }

  const actorId = value.actor_id === null ? null : canonicalUuid(value.actor_id)
  const postId = canonicalUuid(value.post_id)
  const requestId = canonicalRequestId(value.request_id)
  const expectedActorId = expected.actorId === null ? null : canonicalUuid(expected.actorId)
  const expectedPostId = canonicalUuid(expected.postId)
  const expectedRequestId = canonicalRequestId(expected.requestId)
  if (
    (value.actor_id !== null && !actorId) ||
    !postId ||
    !requestId ||
    (expected.actorId !== null && !expectedActorId) ||
    !expectedPostId ||
    !expectedRequestId ||
    actorId !== expectedActorId ||
    postId !== expectedPostId ||
    requestId !== expectedRequestId
  ) {
    return null
  }

  if (value.action === 'absent') {
    if (value.poll !== null || value.user_votes.length !== 0) return null
    return {
      actorId,
      postId,
      requestId,
      operation: POST_CUSTOM_POLL_READ_OPERATION,
      action: 'absent',
      poll: null,
      userVotes: [],
    }
  }

  if (
    !isRecord(value.poll) ||
    !hasExactKeys(value.poll, [
      'end_at',
      'id',
      'is_expired',
      'options',
      'question',
      'show_results',
      'total_votes',
      'type',
    ]) ||
    typeof value.poll.question !== 'string' ||
    value.poll.question.length > 200 ||
    (value.poll.type !== 'single' && value.poll.type !== 'multiple') ||
    typeof value.poll.is_expired !== 'boolean' ||
    typeof value.poll.show_results !== 'boolean' ||
    !Array.isArray(value.poll.options) ||
    value.poll.options.length < 2 ||
    value.poll.options.length > 6 ||
    (value.poll.end_at !== null &&
      (typeof value.poll.end_at !== 'string' || Number.isNaN(Date.parse(value.poll.end_at))))
  ) {
    return null
  }

  const pollId = canonicalUuid(value.poll.id)
  if (!pollId || (value.poll.end_at === null && value.poll.is_expired)) return null

  const options: { text: string; votes: number | null }[] = []
  for (const candidate of value.poll.options) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['text', 'votes']) ||
      !isCanonicalOptionText(candidate.text) ||
      (candidate.votes !== null && !isNonnegativeSafeInteger(candidate.votes))
    ) {
      return null
    }
    options.push({ text: candidate.text, votes: candidate.votes as number | null })
  }
  if (!hasUniqueOptionTexts(options)) return null

  const userVotes = readSortedOptionIndexes(value.user_votes, options.length, value.poll.type)
  if (!userVotes) return null

  if (value.poll.show_results) {
    if (
      !options.every((option) => isNonnegativeSafeInteger(option.votes)) ||
      !isNonnegativeSafeInteger(value.poll.total_votes) ||
      options.reduce((sum, option) => sum + (option.votes as number), 0) !==
        value.poll.total_votes ||
      userVotes.some((index) => (options[index].votes as number) < 1)
    ) {
      return null
    }
  } else if (
    options.some((option) => option.votes !== null) ||
    value.poll.total_votes !== null ||
    value.poll.is_expired ||
    userVotes.length !== 0
  ) {
    return null
  }

  if (value.poll.show_results !== (value.poll.is_expired || userVotes.length > 0)) return null

  return {
    actorId,
    postId,
    requestId,
    operation: POST_CUSTOM_POLL_READ_OPERATION,
    action: 'found',
    poll: {
      id: pollId,
      question: value.poll.question,
      options,
      type: value.poll.type,
      endAt: value.poll.end_at,
      isExpired: value.poll.is_expired,
      showResults: value.poll.show_results,
      totalVotes: value.poll.total_votes as number | null,
    },
    userVotes,
  }
}

/**
 * Accept only the replacement selection for the exact actor, post, poll and
 * request. Option labels and indexes bind the receipt to the snapshot the user
 * acted on, while counts are authoritative absolute totals.
 */
export function readPostCustomPollVoteAcknowledgement(
  value: unknown,
  expected: {
    actorId: string
    postId: string
    pollId: string
    requestId: string
    pollType: PostCustomPollType
    optionTexts: readonly string[]
    optionIndexes: readonly number[]
  }
): PostCustomPollVoteAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'action',
      'actor_id',
      'operation',
      'option_indexes',
      'poll',
      'poll_id',
      'post_id',
      'request_id',
    ]) ||
    value.operation !== POST_CUSTOM_POLL_VOTE_OPERATION ||
    value.action !== 'voted' ||
    !isRecord(value.poll) ||
    !hasExactKeys(value.poll, ['options', 'total_votes']) ||
    !Array.isArray(value.poll.options) ||
    !isNonnegativeSafeInteger(value.poll.total_votes)
  ) {
    return null
  }

  const actorId = canonicalUuid(value.actor_id)
  const postId = canonicalUuid(value.post_id)
  const pollId = canonicalUuid(value.poll_id)
  const requestId = canonicalRequestId(value.request_id)
  const expectedActorId = canonicalUuid(expected.actorId)
  const expectedPostId = canonicalUuid(expected.postId)
  const expectedPollId = canonicalUuid(expected.pollId)
  const expectedRequestId = canonicalRequestId(expected.requestId)
  if (
    !actorId ||
    !postId ||
    !pollId ||
    !requestId ||
    !expectedActorId ||
    !expectedPostId ||
    !expectedPollId ||
    !expectedRequestId ||
    actorId !== expectedActorId ||
    postId !== expectedPostId ||
    pollId !== expectedPollId ||
    requestId !== expectedRequestId ||
    expected.optionTexts.length < 2 ||
    expected.optionTexts.length > 6 ||
    !expected.optionTexts.every(isCanonicalOptionText) ||
    !hasUniqueOptionTexts(expected.optionTexts.map((text) => ({ text })))
  ) {
    return null
  }

  const expectedIndexes = readSortedOptionIndexes(
    [...expected.optionIndexes],
    expected.optionTexts.length,
    expected.pollType
  )
  const optionIndexes = readSortedOptionIndexes(
    value.option_indexes,
    expected.optionTexts.length,
    expected.pollType
  )
  if (
    !expectedIndexes ||
    expectedIndexes.length === 0 ||
    !optionIndexes ||
    !sameNumbers(optionIndexes, expectedIndexes)
  ) {
    return null
  }

  const options: { text: string; votes: number }[] = []
  for (const candidate of value.poll.options) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['text', 'votes']) ||
      !isCanonicalOptionText(candidate.text) ||
      !isNonnegativeSafeInteger(candidate.votes)
    ) {
      return null
    }
    options.push({ text: candidate.text, votes: candidate.votes })
  }
  if (
    !sameStrings(
      options.map((option) => option.text),
      expected.optionTexts
    ) ||
    options.reduce((sum, option) => sum + option.votes, 0) !== value.poll.total_votes ||
    optionIndexes.some((index) => options[index].votes < 1)
  ) {
    return null
  }

  return {
    actorId,
    postId,
    pollId,
    requestId,
    operation: POST_CUSTOM_POLL_VOTE_OPERATION,
    action: 'voted',
    options,
    totalVotes: value.poll.total_votes,
    optionIndexes,
  }
}
