import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CHAT_MEDIA_SIGNED_URL_TTL_SECONDS,
  parseChatMediaUrl,
  refreshAuthorizedChatMediaUrls,
} from '../private-media'

const SCOPE_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_SCOPE_ID = '22222222-2222-4222-8222-222222222222'
const OBJECT_NAME = `${SCOPE_ID}/image/1234-abcdef.webp`
const LEGACY_URL = `https://project.supabase.co/storage/v1/object/public/chat/${OBJECT_NAME}`
const SIGNED_URL = `https://project.supabase.co/storage/v1/object/sign/chat/${OBJECT_NAME}?token=fresh`

function storageClient(createSignedUrls: jest.Mock): SupabaseClient {
  return {
    storage: {
      from: jest.fn(() => ({ createSignedUrls })),
    },
  } as unknown as SupabaseClient
}

describe('private chat media helpers', () => {
  it('accepts canonical legacy and signed URLs only in the authorized scope', () => {
    expect(parseChatMediaUrl(LEGACY_URL, SCOPE_ID)).toEqual({
      objectName: OBJECT_NAME,
      scopeId: SCOPE_ID,
    })
    expect(parseChatMediaUrl(SIGNED_URL, SCOPE_ID)?.objectName).toBe(OBJECT_NAME)
    expect(parseChatMediaUrl(LEGACY_URL, OTHER_SCOPE_ID)).toBeNull()
    expect(
      parseChatMediaUrl(
        `https://project.supabase.co/storage/v1/object/public/chat/${SCOPE_ID}/image/..%2Fsecret`,
        SCOPE_ID
      )
    ).toBeNull()
    expect(
      parseChatMediaUrl('http://project.test/storage/v1/object/public/chat/x', SCOPE_ID)
    ).toBeNull()
  })

  it('re-signs legacy URLs in one batch and preserves unrelated HTTPS media', async () => {
    const createSignedUrls = jest.fn().mockResolvedValue({
      data: [{ path: OBJECT_NAME, signedUrl: SIGNED_URL, error: null }],
      error: null,
    })
    const client = storageClient(createSignedUrls)

    await expect(
      refreshAuthorizedChatMediaUrls(
        client,
        [
          { id: 'private', media_url: LEGACY_URL },
          { id: 'external', media_url: 'https://cdn.example.com/file.pdf' },
          { id: 'none', media_url: null },
        ],
        SCOPE_ID
      )
    ).resolves.toEqual([
      { id: 'private', media_url: SIGNED_URL },
      { id: 'external', media_url: 'https://cdn.example.com/file.pdf' },
      { id: 'none', media_url: null },
    ])
    expect(createSignedUrls).toHaveBeenCalledWith([OBJECT_NAME], CHAT_MEDIA_SIGNED_URL_TTL_SECONDS)
  })

  it.each([
    [{ data: null, error: { message: 'storage unavailable' } }],
    [{ data: [{ path: 'wrong/path', signedUrl: SIGNED_URL }], error: null }],
    [{ data: [{ path: OBJECT_NAME, signedUrl: 'https://attacker.test/value' }], error: null }],
  ])('removes recognized media when signing cannot be proven exact', async (result) => {
    const client = storageClient(jest.fn().mockResolvedValue(result))

    await expect(
      refreshAuthorizedChatMediaUrls(client, [{ media_url: LEGACY_URL }], SCOPE_ID)
    ).resolves.toEqual([{ media_url: null }])
  })

  it('removes a chat URL from another scope without trying to sign it', async () => {
    const createSignedUrls = jest.fn()
    const client = storageClient(createSignedUrls)

    await expect(
      refreshAuthorizedChatMediaUrls(client, [{ media_url: LEGACY_URL }], OTHER_SCOPE_ID)
    ).resolves.toEqual([{ media_url: null }])
    expect(createSignedUrls).not.toHaveBeenCalled()
  })
})
