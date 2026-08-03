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
  content_version: 8,
  updated_at: '2026-07-30T01:35:00.123456+00:00',
}

describe('post edit acknowledgement contract', () => {
  it('accepts exact updated and unchanged RPC acknowledgements', () => {
    expect(readPostEditRpcAcknowledgement({ status: 'updated', actor_id: ACTOR, post })).toEqual({
      status: 'updated',
      actorId: ACTOR,
      post,
    })
    expect(readPostEditRpcAcknowledgement({ status: 'unchanged', actor_id: ACTOR, post })).toEqual({
      status: 'unchanged',
      actorId: ACTOR,
      post,
    })
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
      readPostEditRpcAcknowledgement({ status: 'updated', actor_id: ACTOR, post, extra: true })
    ).toBeNull()
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        post: { ...post, content_version: 1.5 },
      })
    ).toBeNull()
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        post: { ...post, images: ['javascript:alert(1)'] },
      })
    ).toBeNull()
    expect(
      readPostEditRpcAcknowledgement({
        status: 'updated',
        actor_id: ACTOR,
        post: { ...post, unexpected: true },
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
