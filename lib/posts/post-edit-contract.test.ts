import {
  readPostEditApiAcknowledgement,
  readPostEditRpcAcknowledgement,
} from './post-edit-contract'

const ACTOR = '11111111-1111-4111-8111-111111111111'
const POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const post = {
  id: POST,
  author_id: ACTOR,
  group_id: null,
  title: 'Edited title',
  content: 'First line\nSecond line',
  images: ['https://cdn.example/image.png'],
  language: 'en',
  mentions: ['Alice_1'],
  hashtags: ['markets'],
  content_version: 8,
  updated_at: '2026-07-30T01:35:00.123456+00:00',
}

describe('post edit acknowledgement contract', () => {
  it('accepts exact updated and unchanged RPC acknowledgements', () => {
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post,
      })
    ).toEqual({ status: 'updated', actorId: ACTOR, revisionAdvanced: true, post })
    expect(
      readPostEditRpcAcknowledgement({
        status: 'unchanged',
        actor_id: ACTOR,
        revision_advanced: false,
        post,
      })
    ).toEqual({ status: 'unchanged', actorId: ACTOR, revisionAdvanced: false, post })
  })

  it.each(['invalid', 'account_inactive', 'not_found', 'forbidden', 'conflict'])(
    'accepts the exact %s rejection',
    (status) => {
      expect(readPostEditRpcAcknowledgement({ status })).toEqual({ status })
      expect(readPostEditRpcAcknowledgement({ status, post_id: POST })).toBeNull()
    }
  )

  it('rejects malformed, widened, or contradictory success evidence', () => {
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post,
        extra: true,
      })
    ).toBeNull()
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, content_version: 1.5 },
      })
    ).toBeNull()
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, images: ['javascript:alert(1)'] },
      })
    ).toBeNull()
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, unexpected: true },
      })
    ).toBeNull()
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, mentions: ['Alice_1', 'alice_1'] },
      })
    ).toBeNull()
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        revision_advanced: true,
        post: { ...post, hashtags: ['Not-Lower'] },
      })
    ).toBeNull()
  })

  it('accepts only the exact public envelope for the expected post', () => {
    expect(readPostEditApiAcknowledgement({ success: true, post }, POST)).toEqual(post)
    expect(
      readPostEditApiAcknowledgement(
        { success: true, post },
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      )
    ).toBeNull()
    expect(readPostEditApiAcknowledgement({ success: true, post, data: {} }, POST)).toBeNull()
    expect(readPostEditApiAcknowledgement({ success: false, post }, POST)).toBeNull()
  })
})
