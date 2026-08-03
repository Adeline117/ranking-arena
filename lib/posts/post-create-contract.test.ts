import {
  AtomicCreatePostAckSchema,
  PostCreateApiSuccessSchema,
  PostCreateRequestSchema,
} from './post-create-contract'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const AUTHOR_ID = '33333333-3333-4333-8333-333333333333'
const GROUP_ID = '44444444-4444-4444-8444-444444444444'
const POLL_ID = '55555555-5555-4555-8555-555555555555'

const post = {
  id: POST_ID,
  author_id: AUTHOR_ID,
  author_handle: 'alice',
  group_id: null,
  title: 'Market outlook',
  content: 'First line\nSecond line',
  images: ['https://cdn.example.com/chart.png'],
  poll_enabled: true,
  poll_id: POLL_ID,
  visibility: 'public' as const,
  is_sensitive: false,
  content_warning: null,
  language: 'en',
  mentions: ['bob'],
  hashtags: ['markets'],
  author_arena_score: 42.5,
  author_is_verified: true,
  content_version: 0,
  status: 'active' as const,
  created_at: '2026-08-03T12:34:56.123456+00:00',
  updated_at: '2026-08-03T12:34:56.123456+00:00',
}

const poll = {
  id: POLL_ID,
  post_id: POST_ID,
  question: 'Market outlook',
  options: [
    { text: 'Bullish', votes: 0, index: 0 },
    { text: 'Bearish', votes: 0, index: 1 },
  ],
  type: 'single' as const,
  end_at: null,
}

const acknowledgement = {
  status: 'created' as const,
  applied: true,
  operation_id: OPERATION_ID,
  actor_id: AUTHOR_ID,
  post,
  poll,
}

describe('PostCreateRequestSchema', () => {
  it('trims required text, preserves internal line breaks, and applies safe defaults', () => {
    expect(
      PostCreateRequestSchema.parse({
        title: '  Market outlook  ',
        content: '  First line\nSecond line  ',
      })
    ).toEqual({
      title: 'Market outlook',
      content: 'First line\nSecond line',
      images: [],
      poll_enabled: false,
      visibility: 'public',
      is_sensitive: false,
    })
  })

  it('accepts an optional idempotency key and matching group visibility', () => {
    expect(
      PostCreateRequestSchema.safeParse({
        operation_id: OPERATION_ID,
        title: 'Group post',
        content: 'Hello group',
        group_id: GROUP_ID,
        visibility: 'group',
        images: ['https://cdn.example.com/a.png', 'http://cdn.example.com/b.png'],
        content_warning: null,
      }).success
    ).toBe(true)
  })

  it('is strict and rejects malformed identifiers and empty trimmed text', () => {
    expect(
      PostCreateRequestSchema.safeParse({ title: 'Title', content: 'Body', extra: true }).success
    ).toBe(false)
    expect(
      PostCreateRequestSchema.safeParse({
        operation_id: 'not-an-id',
        title: 'Title',
        content: 'Body',
      }).success
    ).toBe(false)
    expect(PostCreateRequestSchema.safeParse({ title: '   ', content: 'Body' }).success).toBe(false)
    expect(PostCreateRequestSchema.safeParse({ title: 'Title', content: '\n\t ' }).success).toBe(
      false
    )
  })

  it('accepts only unique HTTP(S) image URLs within the limits', () => {
    const base = { title: 'Title', content: 'Body' }
    for (const images of [
      ['javascript:alert(1)'],
      ['https://cdn.example.com/a b.png'],
      ['https://cdn.example.com/a.png', 'https://cdn.example.com/a.png'],
      Array.from({ length: 10 }, (_, index) => `https://cdn.example.com/${index}.png`),
    ]) {
      expect(PostCreateRequestSchema.safeParse({ ...base, images }).success).toBe(false)
    }
  })

  it('requires group visibility and group identity to agree', () => {
    const base = { title: 'Title', content: 'Body' }
    expect(
      PostCreateRequestSchema.safeParse({ ...base, group_id: GROUP_ID, visibility: 'public' })
        .success
    ).toBe(false)
    expect(PostCreateRequestSchema.safeParse({ ...base, visibility: 'group' }).success).toBe(false)
    expect(
      PostCreateRequestSchema.safeParse({ ...base, group_id: GROUP_ID, visibility: 'group' })
        .success
    ).toBe(true)
  })

  it('accepts both legacy tri-state and complete custom polls', () => {
    const base = { title: 'Direction', content: 'Choose one', poll_enabled: true }
    expect(PostCreateRequestSchema.safeParse(base).success).toBe(true)
    expect(
      PostCreateRequestSchema.parse({
        ...base,
        poll_options: ['  Bullish ', 'Bearish'],
        poll_type: 'single',
        poll_duration_hours: 0,
      })
    ).toMatchObject({ poll_options: ['Bullish', 'Bearish'], poll_duration_hours: 0 })
  })

  it('rejects incomplete, duplicate, oversized, or disabled custom poll settings', () => {
    const base = { title: 'Direction', content: 'Choose one', poll_enabled: true }
    expect(
      PostCreateRequestSchema.safeParse({ ...base, poll_options: ['Yes', 'No'] }).success
    ).toBe(false)
    expect(
      PostCreateRequestSchema.safeParse({
        ...base,
        poll_options: ['Bull', ' bull '],
        poll_type: 'multiple',
        poll_duration_hours: 24,
      }).success
    ).toBe(false)
    expect(
      PostCreateRequestSchema.safeParse({
        ...base,
        poll_options: ['Yes', 'No'],
        poll_type: 'single',
        poll_duration_hours: 169,
      }).success
    ).toBe(false)
    expect(
      PostCreateRequestSchema.safeParse({
        title: 'Direction',
        content: 'Choose one',
        poll_enabled: false,
        poll_type: null,
      }).success
    ).toBe(false)
  })

  it('allows a nullable warning but rejects warning text on non-sensitive content', () => {
    const base = { title: 'Title', content: 'Body' }
    expect(PostCreateRequestSchema.safeParse({ ...base, content_warning: null }).success).toBe(true)
    expect(PostCreateRequestSchema.safeParse({ ...base, content_warning: 'Spoiler' }).success).toBe(
      false
    )
    expect(
      PostCreateRequestSchema.safeParse({
        ...base,
        is_sensitive: true,
        content_warning: '  Spoiler  ',
      }).data?.content_warning
    ).toBe('Spoiler')
  })
})

describe('AtomicCreatePostAckSchema', () => {
  it('accepts exact created and replayed acknowledgements', () => {
    expect(AtomicCreatePostAckSchema.parse(acknowledgement)).toEqual(acknowledgement)
    expect(
      AtomicCreatePostAckSchema.parse({ ...acknowledgement, status: 'replayed', applied: false })
    ).toEqual({ ...acknowledgement, status: 'replayed', applied: false })
  })

  it('accepts legacy tri-state poll evidence without a custom poll row', () => {
    expect(
      AtomicCreatePostAckSchema.safeParse({
        ...acknowledgement,
        post: { ...post, poll_id: null },
        poll: null,
      }).success
    ).toBe(true)
  })

  it('rejects widened, malformed, or contradictory acknowledgement evidence', () => {
    const invalid = [
      { ...acknowledgement, extra: true },
      { ...acknowledgement, operation_id: 'not-an-id' },
      { ...acknowledgement, status: 'created', applied: false },
      { ...acknowledgement, actor_id: GROUP_ID },
      { ...acknowledgement, post: { ...post, images: ['data:image/png,x'] } },
      { ...acknowledgement, post: { ...post, content_version: -1 } },
      { ...acknowledgement, post: { ...post, poll_enabled: false } },
      { ...acknowledgement, post: { ...post, poll_id: GROUP_ID } },
      { ...acknowledgement, poll: { ...poll, post_id: GROUP_ID } },
      { ...acknowledgement, poll: { ...poll, options: [{ text: 'Only', votes: 0, index: 0 }] } },
      { ...acknowledgement, post: { ...post, created_at: '2026-08-03' } },
    ]
    for (const value of invalid) {
      expect(AtomicCreatePostAckSchema.safeParse(value).success).toBe(false)
    }
  })
})

describe('PostCreateApiSuccessSchema', () => {
  it('accepts only the exact nested API success envelope', () => {
    const response = {
      success: true as const,
      data: {
        post,
        poll,
        operation: {
          status: acknowledgement.status,
          applied: acknowledgement.applied,
          operation_id: acknowledgement.operation_id,
        },
      },
    }

    expect(PostCreateApiSuccessSchema.parse(response)).toEqual(response)
    expect(
      PostCreateApiSuccessSchema.safeParse({
        ...response,
        data: { ...response.data, unexpected: true },
      }).success
    ).toBe(false)
    expect(
      PostCreateApiSuccessSchema.safeParse({
        ...response,
        data: { ...response.data, operation: { ...response.data.operation, applied: false } },
      }).success
    ).toBe(false)
    expect(
      PostCreateApiSuccessSchema.safeParse({
        ...response,
        data: { ...response.data, poll: { ...poll, post_id: GROUP_ID } },
      }).success
    ).toBe(false)
  })
})
