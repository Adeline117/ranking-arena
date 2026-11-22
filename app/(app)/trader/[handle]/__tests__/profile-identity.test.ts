import {
  LOOKUP_UNAVAILABLE,
  requestedPlatform,
  resolveProfileIdentity,
  type LegacyIdentity,
  type ProfileIdentityDeps,
  type Unavailable,
} from '../profile-identity'

type Serving = { source: string; exchangeTraderId: string; publicSource?: string | null }
type LegacyAnswer = LegacyIdentity | null | Unavailable
type ServingAnswer = Serving | null | Unavailable

// The serving set exposes both arena slugs and public aliases (blofin, gateio).
const SERVING_SOURCES = new Set([
  'okx_futures',
  'okx_spot',
  'gate_futures',
  'gateio',
  'blofin_futures',
  'blofin',
])
const RETIRED = new Set(['bybit_spot'])

function legacyRow(platform: string, traderKey = '3355'): LegacyIdentity {
  return { platform, traderKey, handle: 'Alice', avatarUrl: null }
}

/** Answers are keyed by the platform/hint argument; '' is the handle-only lookup. */
function deps(
  legacy: Record<string, LegacyAnswer>,
  serving: Record<string, ServingAnswer>
): ProfileIdentityDeps<Serving> & { legacyCalls: string[]; servingCalls: string[] } {
  const legacyCalls: string[] = []
  const servingCalls: string[] = []
  return {
    legacyCalls,
    servingCalls,
    resolveLegacy: async (_handle, platform) => {
      legacyCalls.push(platform ?? '')
      return legacy[platform ?? ''] ?? null
    },
    resolveServing: async (_handle, source) => {
      servingCalls.push(source ?? '')
      return serving[source ?? ''] ?? null
    },
    isServingSource: async (source) => SERVING_SOURCES.has(source),
    isRetiredSource: (source) => RETIRED.has(source),
  }
}

describe('requestedPlatform', () => {
  it('accepts a plain source key and takes the first of repeated params', () => {
    expect(requestedPlatform('okx_futures')).toBe('okx_futures')
    expect(requestedPlatform(['okx_spot', 'okx_futures'])).toBe('okx_spot')
  })

  it('ignores anything that is not a source key', () => {
    for (const raw of [undefined, '', 'OKX', 'okx-futures', 'a b', 'x'.repeat(49), "okx';--"]) {
      expect(requestedPlatform(raw)).toBeUndefined()
    }
  })
})

describe('resolveProfileIdentity', () => {
  it('resolves the account named by ?platform= when the id is shared across sources', async () => {
    const d = deps(
      {},
      {
        // Handle-only lookup picks the futures account…
        '': { source: 'okx_futures', exchangeTraderId: '3355' },
        okx_futures: { source: 'okx_futures', exchangeTraderId: '3355' },
        // …but the URL asked for the spot account with the same id.
        okx_spot: { source: 'okx_spot', exchangeTraderId: '3355' },
      }
    )
    const identity = await resolveProfileIdentity(d, '3355', 'okx_spot')
    expect(identity.serving).toEqual({ source: 'okx_spot', exchangeTraderId: '3355' })
    expect(identity.missing).toBe(false)
  })

  it('keeps the previous handle-only behaviour when no platform is given', async () => {
    const d = deps({}, { '': { source: 'okx_futures', exchangeTraderId: '3355' } })
    const identity = await resolveProfileIdentity(d, '3355', undefined)
    expect(identity.serving?.source).toBe('okx_futures')
    expect(d.legacyCalls).toEqual([''])
    expect(d.servingCalls).toEqual([''])
  })

  it('falls back to the handle-only lookup when the platform matches nothing', async () => {
    const d = deps(
      { '': legacyRow('gate_futures') },
      { gate_futures: { source: 'gate_futures', exchangeTraderId: '3355' } }
    )
    const identity = await resolveProfileIdentity(d, '3355', 'okx_spot')
    expect(identity.serving?.source).toBe('gate_futures')
    expect(identity.missing).toBe(false)
  })

  it('disambiguates a legacy handle that is ambiguous without the platform', async () => {
    // Handle-only legacy lookup is ambiguous (→ null); with the platform it is unique.
    const d = deps({ htx_futures: legacyRow('htx_futures', 'k1') }, {})
    const identity = await resolveProfileIdentity(d, 'Alice', 'htx_futures')
    expect(identity.legacy).toEqual(legacyRow('htx_futures', 'k1'))
    expect(identity.missing).toBe(false)
  })

  it('lets a live serving trader win over a stale legacy row with the same id', async () => {
    const d = deps(
      { '': legacyRow('xt') },
      { '': { source: 'gate_futures', exchangeTraderId: '3355' } }
    )
    const identity = await resolveProfileIdentity(d, '3355', undefined)
    expect(identity.serving?.source).toBe('gate_futures')
    // The stale non-serving legacy platform must not be used as the hint.
    expect(d.servingCalls).toEqual([''])
  })

  it('ignores a serving-resolver hit whose source is not in serving mode', async () => {
    const d = deps({}, { '': { source: 'legacy_only', exchangeTraderId: '1' } })
    const identity = await resolveProfileIdentity(d, 'x', undefined)
    expect(identity.serving).toBeNull()
    expect(identity.missing).toBe(true)
  })

  it('marks a handle unknown to both resolvers as missing', async () => {
    const identity = await resolveProfileIdentity(deps({}, {}), 'nobody', 'okx_spot')
    expect(identity).toEqual({ legacy: null, serving: null, publicSource: null, missing: true })
  })

  it('marks a trader known only under a retired source as missing', async () => {
    const identity = await resolveProfileIdentity(
      deps({ '': legacyRow('bybit_spot') }, {}),
      'Alice',
      undefined
    )
    expect(identity.missing).toBe(true)
  })

  it('never calls an unavailable lookup "missing"', async () => {
    const servingDown = await resolveProfileIdentity(
      deps({}, { '': LOOKUP_UNAVAILABLE }),
      'someone',
      undefined
    )
    expect(servingDown.missing).toBe(false)

    const legacyDown = await resolveProfileIdentity(
      deps({ '': LOOKUP_UNAVAILABLE }, {}),
      'someone',
      undefined
    )
    expect(legacyDown.missing).toBe(false)
    expect(legacyDown.legacy).toBe(LOOKUP_UNAVAILABLE)
  })
})

describe('publicSource (the name the public ranking uses)', () => {
  const blofin = { source: 'blofin_futures', exchangeTraderId: '585' }

  it('is the alias when the request names the account by its public alias', async () => {
    const d = deps({ blofin: legacyRow('blofin', '585') }, { blofin })
    const identity = await resolveProfileIdentity(d, '585', 'blofin')
    expect(identity.serving).toEqual(blofin)
    expect(identity.publicSource).toBe('blofin')
  })

  it('is the alias when a handle-only request is matched through the legacy platform', async () => {
    const d = deps({ '': legacyRow('blofin', '585') }, { blofin })
    const identity = await resolveProfileIdentity(d, '585', undefined)
    expect(identity.publicSource).toBe('blofin')
  })

  it('is the alias when the request uses the slug and the resolver confirms the legacy name', async () => {
    const d = deps({ '': legacyRow('blofin', '585') }, { blofin_futures: blofin, blofin })
    const identity = await resolveProfileIdentity(d, '585', 'blofin_futures')
    expect(identity.serving).toEqual(blofin)
    expect(identity.publicSource).toBe('blofin')
  })

  it('stays the slug when the legacy name resolves to a different account', async () => {
    const d = deps(
      { '': legacyRow('gateio', '585') },
      { blofin_futures: blofin, gateio: { source: 'gate_futures', exchangeTraderId: '585' } }
    )
    const identity = await resolveProfileIdentity(d, '585', 'blofin_futures')
    expect(identity.publicSource).toBe('blofin_futures')
  })

  it('takes the resolver-reported public name over any inference', async () => {
    // Requested by slug, no legacy row at all: only the resolver knows the alias.
    const d = deps({}, { blofin_futures: { ...blofin, publicSource: 'blofin' } })
    const identity = await resolveProfileIdentity(d, '585', 'blofin_futures')
    expect(identity.publicSource).toBe('blofin')
    expect(d.servingCalls).toEqual(['blofin_futures'])
  })

  it('is the slug for a source with no alias', async () => {
    const okx = { source: 'okx_futures', exchangeTraderId: '3355' }
    const d = deps({}, { okx_futures: okx })
    const identity = await resolveProfileIdentity(d, '3355', 'okx_futures')
    expect(identity.publicSource).toBe('okx_futures')
  })

  it('is the legacy platform for a legacy-only account and null when there is none', async () => {
    const legacyOnly = await resolveProfileIdentity(
      deps({ '': legacyRow('mexc') }, {}),
      'Alice',
      undefined
    )
    expect(legacyOnly.publicSource).toBe('mexc')
    const missing = await resolveProfileIdentity(deps({}, {}), 'nobody', undefined)
    expect(missing.publicSource).toBeNull()
    const retired = await resolveProfileIdentity(
      deps({ '': legacyRow('bybit_spot') }, {}),
      'Alice',
      undefined
    )
    expect(retired.publicSource).toBeNull()
  })
})
