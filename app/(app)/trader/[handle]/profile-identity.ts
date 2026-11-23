/**
 * The ONE identity resolution for a trader profile request, shared by
 * generateMetadata and the page so the canonical tag, robots, JSON-LD and the
 * rendered profile always describe the same account.
 *
 * Kept free of Next/Supabase imports: page.tsx injects its cached lookups, and
 * the rules below are unit-tested without a database.
 *
 * - `platform` (the URL's ?platform=) is tried first in both resolvers. Without
 *   it the server picked an account from the handle alone: a handle shared
 *   across sources resolved to someone else (or to "ambiguous" → not found →
 *   noindex) while the client, which does read ?platform=, showed the right
 *   trader.
 * - A platform that matches nothing falls back to the handle-only lookup, so a
 *   stale or mistyped ?platform= can never make a resolvable trader disappear.
 * - A serving-mode match wins over the legacy one: legacy tables still hold
 *   stale rows keyed by the same id/handle as a live serving trader.
 * - A lookup that timed out or failed is UNAVAILABLE, never "missing".
 */

/** A lookup that timed out or errored — it has no answer. */
export const LOOKUP_UNAVAILABLE: unique symbol = Symbol('lookup-unavailable')
export type Unavailable = typeof LOOKUP_UNAVAILABLE

export interface LegacyIdentity {
  platform: string
  traderKey: string
  handle: string | null
  avatarUrl: string | null
}

export interface ProfileIdentityDeps<Serving extends { source: string }> {
  resolveLegacy: (handle: string, platform?: string) => Promise<LegacyIdentity | null | Unavailable>
  resolveServing: (handle: string, source?: string) => Promise<Serving | null | Unavailable>
  isServingSource: (source: string) => Promise<boolean>
  isRetiredSource: (source: string) => boolean
}

export interface ProfileIdentity<Serving> {
  legacy: LegacyIdentity | null | Unavailable
  serving: Serving | null
  /** No public profile: render the not-found view and mark the page noindex. */
  missing: boolean
}

/**
 * `?platform=` names which account a shared handle/id belongs to. Only a plain
 * source key is accepted — anything else is ignored and resolution falls back
 * to the handle alone.
 */
export function requestedPlatform(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && /^[a-z0-9_]{1,48}$/.test(value) ? value : undefined
}

export async function resolveProfileIdentity<Serving extends { source: string }>(
  deps: ProfileIdentityDeps<Serving>,
  handle: string,
  platform: string | undefined
): Promise<ProfileIdentity<Serving>> {
  let legacy = platform ? await deps.resolveLegacy(handle, platform) : null
  if (!legacy) legacy = await deps.resolveLegacy(handle)

  let servingUnavailable = false
  const servingMatch = async (hint: string | undefined): Promise<Serving | null> => {
    const outcome = await deps.resolveServing(handle, hint)
    if (outcome === LOOKUP_UNAVAILABLE) {
      servingUnavailable = true
      return null
    }
    return outcome && (await deps.isServingSource(outcome.source)) ? outcome : null
  }

  let serving =
    platform && (await deps.isServingSource(platform)) ? await servingMatch(platform) : null
  if (!serving) {
    // Only pass the legacy platform as a source hint when it is ITSELF a serving
    // source. The serving resolver returns NOTHING for a stale non-serving hint
    // (e.g. "xt"/"bybit_spot") even though the handle resolves cleanly with no
    // hint — so a stale legacy hint would hide the live serving trader.
    const legacyPlatform = legacy && legacy !== LOOKUP_UNAVAILABLE ? legacy.platform : undefined
    const hint =
      legacyPlatform && (await deps.isServingSource(legacyPlatform)) ? legacyPlatform : undefined
    serving = await servingMatch(hint)
  }

  // Unknown to both resolvers, or known only under a retired source with no
  // live serving account.
  const missing =
    !serving &&
    !servingUnavailable &&
    legacy !== LOOKUP_UNAVAILABLE &&
    (!legacy || deps.isRetiredSource(legacy.platform))

  return { legacy, serving, missing }
}
