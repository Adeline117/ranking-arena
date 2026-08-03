const mockAuthedFetch = jest.fn()

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

import { savePostToBookmarkFolder } from '@/lib/bookmarks/folder-save-client'

const input = {
  accessToken: 'access-token',
  userId: '11111111-1111-4111-8111-111111111111',
  postId: '22222222-2222-4222-8222-222222222222',
  folderId: '33333333-3333-4333-8333-333333333333',
  sessionGeneration: 7,
}
const success = {
  status: 'already_saved',
  user_id: input.userId,
  post_id: input.postId,
  bookmark_id: '44444444-4444-4444-8444-444444444444',
  folder_id: input.folderId,
  bookmarked: true,
  bookmark_count: 9,
}

describe('savePostToBookmarkFolder', () => {
  beforeEach(() => jest.clearAllMocks())

  it('retries one uncertain transport result with the exact same idempotent command', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce({ ok: false, status: 0, data: null })
      .mockResolvedValueOnce({ ok: true, status: 200, data: success })

    await expect(savePostToBookmarkFolder(input)).resolves.toEqual({
      ok: true,
      acknowledgement: success,
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(mockAuthedFetch.mock.calls[0]).toEqual(mockAuthedFetch.mock.calls[1])
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      `/api/posts/${input.postId}/bookmark`,
      'POST',
      input.accessToken,
      { folder_id: input.folderId },
      8_000,
      {
        expectedUserId: input.userId,
        expectedSessionGeneration: input.sessionGeneration,
        signal: undefined,
      }
    )
  })

  it('does not retry an authoritative HTTP rejection', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 404,
      data: { error: 'Bookmark folder not found' },
    })

    await expect(savePostToBookmarkFolder(input)).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'Bookmark folder not found',
      stale: false,
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
  })

  it('safely retries one thrown transport failure because the command is idempotent', async () => {
    mockAuthedFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, status: 200, data: success })

    await expect(savePostToBookmarkFolder(input)).resolves.toEqual({
      ok: true,
      acknowledgement: success,
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
  })

  it('fails closed on a success payload for another identity', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...success, user_id: '55555555-5555-4555-8555-555555555555' },
    })

    await expect(savePostToBookmarkFolder(input)).resolves.toEqual({
      ok: false,
      status: 502,
      error: null,
      stale: false,
    })
  })

  it('never retries or exposes a stale viewer result', async () => {
    mockAuthedFetch.mockResolvedValue({ ok: false, status: 0, data: null, stale: true })

    await expect(savePostToBookmarkFolder(input)).resolves.toEqual({
      ok: false,
      status: 0,
      error: null,
      stale: true,
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
  })
})
