jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn() },
}))

import { attachAvatarMirrors } from '../avatar-mirrors'

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
