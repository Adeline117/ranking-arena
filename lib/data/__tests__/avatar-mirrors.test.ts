jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn() },
}))

import { attachAvatarMirrors, resetAvatarMirrorCacheForTests } from '../avatar-mirrors'

beforeEach(() => resetAvatarMirrorCacheForTests())

describe('attachAvatarMirrors cancellation', () => {
  it('applies the caller-owned AbortSignal to the mirror RPC', async () => {
    const signal = new AbortController().signal
    const query = {
      abortSignal: jest.fn().mockResolvedValue({ data: [], error: null }),
    }
    const supabase = {
      rpc: jest.fn(() => query),
    }
    const traders = [
      {
        id: 'trader-1',
        source: 'binance_futures',
        avatar_url_mirror: null,
      },
    ]

    await expect(attachAvatarMirrors(supabase as never, traders, signal)).resolves.toBe(traders)

    expect(query.abortSignal).toHaveBeenCalledTimes(1)
    expect(query.abortSignal).toHaveBeenCalledWith(signal)
  })
})

describe('attachAvatarMirrors in-process cache', () => {
  function client(rows: unknown[] | null, error: { message: string } | null = null) {
    const rpc = jest.fn(() => Promise.resolve({ data: rows, error }))
    return { supabase: { rpc } as never, rpc }
  }

  it('only queries traders not already cached (including negative hits)', async () => {
    const first = client([
      { source: 'okx', exchange_trader_id: 'a', avatar_url_mirror: 'https://cdn/a.png' },
    ])
    const traders = [
      { id: 'a', source: 'okx', avatar_url_mirror: null },
      { id: 'b', source: 'okx', avatar_url_mirror: null },
    ]
    const out1 = await attachAvatarMirrors(first.supabase, traders)
    expect(out1[0].avatar_url_mirror).toBe('https://cdn/a.png')
    expect(out1[1].avatar_url_mirror).toBeNull()

    const second = client([])
    const out2 = await attachAvatarMirrors(second.supabase, [
      ...traders,
      { id: 'c', source: 'okx', avatar_url_mirror: null },
    ])
    expect(second.rpc).toHaveBeenCalledTimes(1)
    expect(second.rpc).toHaveBeenCalledWith('arena_avatar_mirrors', {
      p_sources: ['okx'],
      p_trader_ids: ['c'],
    })
    expect(out2[0].avatar_url_mirror).toBe('https://cdn/a.png')

    const third = client([])
    await attachAvatarMirrors(third.supabase, traders)
    expect(third.rpc).not.toHaveBeenCalled()
  })

  it('does not cache RPC errors', async () => {
    const failing = client(null, { message: 'boom' })
    const traders = [{ id: 'a', source: 'okx', avatar_url_mirror: null }]
    await expect(attachAvatarMirrors(failing.supabase, traders)).resolves.toBe(traders)

    const retry = client([])
    await attachAvatarMirrors(retry.supabase, traders)
    expect(retry.rpc).toHaveBeenCalledTimes(1)
  })
})
