import {
  canServiceActorReadPostStrict,
  filterServiceReadablePostRowsStrict,
} from '@/lib/data/service-post-audience'

type AudienceClient = Parameters<typeof filterServiceReadablePostRowsStrict>[0]

describe('strict service post audience snapshots', () => {
  it('keeps an explicit denial distinct from authority failure', async () => {
    const rows = [{ id: 'readable-post' }, { id: 'denied-post' }]
    const rpc = jest.fn((_name: string, args: { p_post_id: string }) =>
      Promise.resolve({ data: args.p_post_id === 'readable-post', error: null })
    )

    await expect(
      filterServiceReadablePostRowsStrict({ rpc } as AudienceClient, rows, 'viewer-1')
    ).resolves.toEqual([rows[0]])
    await expect(
      canServiceActorReadPostStrict({ rpc } as AudienceClient, 'denied-post', 'viewer-1')
    ).resolves.toBe(false)
  })

  it.each([
    ['database error', () => Promise.resolve({ data: null, error: { code: 'XX000' } })],
    ['malformed acknowledgement', () => Promise.resolve({ data: null, error: null })],
    ['thrown transport error', () => Promise.reject(new Error('network failed'))],
  ])('rejects the whole snapshot on %s instead of fabricating false', async (_label, reply) => {
    const rpc = jest.fn(reply)

    await expect(
      filterServiceReadablePostRowsStrict(
        { rpc } as AudienceClient,
        [{ id: 'post-1' }, { id: 'post-2' }],
        'viewer-1'
      )
    ).rejects.toThrow('Canonical post audience authority unavailable')
  })

  it('does not call authority for an empty candidate set', async () => {
    const rpc = jest.fn()

    await expect(
      filterServiceReadablePostRowsStrict({ rpc } as AudienceClient, [], 'viewer-1')
    ).resolves.toEqual([])
    expect(rpc).not.toHaveBeenCalled()
  })
})
