import { parsePostReactionAcknowledgement } from '../post-reactions-client'

describe('parsePostReactionAcknowledgement', () => {
  it.each([
    {
      name: 'added reaction with canonical counts',
      envelope: {
        success: true,
        data: { action: 'added', reaction: 'up', like_count: 4, dislike_count: 1 },
      },
      requested: 'up' as const,
    },
    {
      name: 'removed reaction with unavailable counts',
      envelope: {
        success: true,
        data: { action: 'removed', reaction: null, like_count: null, dislike_count: null },
      },
      requested: 'down' as const,
    },
  ])('accepts $name', ({ envelope, requested }) => {
    expect(parsePostReactionAcknowledgement(envelope, requested)).toEqual(envelope.data)
  })

  it.each([
    ['a failed envelope', { success: false, data: {} }],
    [
      'a missing action',
      { success: true, data: { reaction: 'up', like_count: 1, dislike_count: 0 } },
    ],
    [
      'a missing count',
      { success: true, data: { action: 'added', reaction: 'up', like_count: 1 } },
    ],
    [
      'a negative count',
      {
        success: true,
        data: { action: 'added', reaction: 'up', like_count: -1, dislike_count: 0 },
      },
    ],
    [
      'a fractional count',
      {
        success: true,
        data: { action: 'added', reaction: 'up', like_count: 1.5, dislike_count: 0 },
      },
    ],
    [
      'a removed action that still has a reaction',
      {
        success: true,
        data: { action: 'removed', reaction: 'up', like_count: 1, dislike_count: 0 },
      },
    ],
    [
      'a reaction that differs from the request',
      {
        success: true,
        data: { action: 'changed', reaction: 'down', like_count: 1, dislike_count: 0 },
      },
    ],
  ])('rejects %s', (_name, envelope) => {
    expect(parsePostReactionAcknowledgement(envelope, 'up')).toBeNull()
  })
})
